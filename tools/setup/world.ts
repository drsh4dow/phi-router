import {
	Array,
	Effect,
	FileSystem,
	Layer,
	Path,
	Queue,
	Record,
	Ref,
	String as Str,
	Stream,
	Struct,
	pipe,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { packageCopy, piCli, pluginCopy } from "#tools/plugin/copied.ts";
import { NodeHttpServer } from "@effect/platform-node";
import { enabled } from "#tools/codex/configured.ts";
import { ran } from "#tools/lifecycle/launched.ts";

const keys = {
	anthropic: "sk-ant-api03-phi-test-baa-key",
	openai: "sk-proj-phi-test-openai-key",
	refused: "sk-ant-api03-phi-test-refused-key",
	subscription: "sk-ant-oat01-phi-test-subscription-token",
} as const;

const accepted: ReadonlySet<string> = new Set([keys.anthropic, keys.openai]);

const statuses = { notFound: 404, ok: 200, unauthorized: 401 } as const;

const keyMock = Effect.gen(function* keyMock() {
	const server = yield* Layer.build(NodeHttpServer.layerTest);
	const checked = yield* Ref.make<readonly string[]>([]);

	const answer = Effect.gen(function* answer() {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const bearer = Str.replace(/^Bearer /u, "")(request.headers["authorization"] ?? "");
		const key = request.headers["x-api-key"] ?? bearer;

		if (request.method !== "GET" || request.url !== "/v1/models") {
			return HttpServerResponse.empty({ status: statuses.notFound });
		}

		yield* Ref.update(checked, Array.append(key));

		if (accepted.has(key)) {
			return HttpServerResponse.empty({ status: statuses.ok });
		}

		return HttpServerResponse.empty({ status: statuses.unauthorized });
	});

	const endpoint = yield* Effect.provideContext(
		Effect.gen(function* serve() {
			const http = yield* HttpServer.HttpServer;

			yield* http.serve(answer);

			return HttpServer.formatAddress(http.address);
		}),
		server,
	);

	return { checkedKeys: (): Effect.Effect<readonly string[]> => Ref.get(checked), endpoint };
});

const claudeStandIn = new URL("../claude/stand-in.ts", import.meta.url).pathname;

const codexStandIn = new URL("../codex/stand-in.ts", import.meta.url).pathname;

interface Copies {
	readonly claudePlugin: string;
	readonly piPackage: string;
}

const fakes = (copies: Copies): Readonly<Record<string, string>> => {
	const installedPlugins = `{"version":2,"plugins":{"phi-router@phi-router":[{"installPath":"${copies.claudePlugin}","scope":"user"}]}}`;
	const cache = '"$CODEX_HOME/plugins/cache/phi-router/phi-router"';
	const hang = '[ -e "$here/hang" ] && { : > "$here/canary-ran"; exec sleep 30; }; [ -e "$here/fail" ] && exit 1';

	const enable =
		'const f = process.env.CLAUDE_CONFIG_DIR + "/settings.json"; const fs = require("fs"); const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {}; s.extraKnownMarketplaces = { "phi-router": { source: { source: "directory", path: process.env.PHI_SOURCE } } }; s.enabledPlugins = Object.assign({}, s.enabledPlugins, { "phi-router@phi-router": true }); fs.writeFileSync(f, JSON.stringify(s, null, 2))';

	return {
		claude: `case "$*" in
"plugin "*) mkdir -p "$CLAUDE_CONFIG_DIR/plugins"; printf '%s' '${installedPlugins}' > "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json"; PHI_SOURCE="$5" "$here/bun" -e '${enable}'; exit 0;;
"") echo "claude started"; exit 0;;
esac
${hang}
exec "$here/bun" '${claudeStandIn}' "$@"`,
		codex: `case "$*" in
"plugin marketplace "*) printf '\n[marketplaces.phi-router]\nsource_type = "local"\nsource = "%s"\n' "$4" >> "$CODEX_HOME/config.toml"; exit 0;;
"plugin add "*) mkdir -p ${cache}; cp -R '${copies.claudePlugin}' ${cache}/0.1.0; printf '%s' '${enabled}' >> "$CODEX_HOME/config.toml"; exit 0;;
"") echo "codex started"; exit 0;;
esac
${hang}
if [ -f "$CODEX_HOME/.env" ]; then set -a; . "$CODEX_HOME/.env"; set +a; fi; no_proxy=\${NO_PROXY-$no_proxy}
exec "$here/bun" '${codexStandIn}' "$@"`,
		pi: `case "$*" in
"--model phi/auto") echo "pi started"; exit 0;;
"-p "*) ${hang};;
"install npm:"*) exec "$here/bun" '${piCli}' install '${copies.piPackage}';;
esac
exec "$here/bun" '${piCli}' "$@"`,
	};
};

const fakeBin = Effect.fnUntraced(function* fakeBin(copies: Copies) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const bin = yield* fs.makeTempDirectoryScoped({ prefix: "phi-setup-bin-" });
	const { printed: bun } = yield* ran(["bun", "-e", "process.stdout.write(process.execPath)"], {});

	yield* fs.symlink(bun, path.join(bin, "bun"));

	yield* Effect.forEach(
		Record.toEntries(fakes(copies)),
		([name, body]) =>
			fs.writeFileString(
				path.join(bin, name),
				`#!/bin/sh\nhere=\${0%/*}\nprintf '%s\\n' "$*" >> "$here/${name}-args"\n${body}\n`,
				{ mode: 0o755 },
			),
		{ concurrency: 1 },
	);

	return bin;
});

const rootFolders = Effect.gen(function* rootFolders() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.makeTempDirectoryScoped({ prefix: "phi-setup-" });

	const folders = pipe(
		{ CLAUDE_CONFIG_DIR: "claude", CODEX_HOME: "codex", HOME: "home", PI_CODING_AGENT_DIR: "pi" },
		Record.map((name) => path.join(root, name)),
	);

	const xdg = pipe(
		{ XDG_CACHE_HOME: "cache", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_STATE_HOME: "state" },
		Record.map((name) => path.join(root, name)),
	);

	yield* Effect.forEach(Record.values(folders), (folder) => fs.makeDirectory(folder), { concurrency: 1 });

	return { folders, root, xdg };
});

interface World {
	readonly checkedKeys: () => Effect.Effect<readonly string[]>;
	readonly copies: Copies;
	readonly env: Readonly<Record<string, string>>;
	readonly fakeHarnessFolder: string;
	readonly folders: Readonly<Record<"CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "PI_CODING_AGENT_DIR", string>>;
	readonly root: string;
	readonly xdg: Readonly<Record<"XDG_CACHE_HOME" | "XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_STATE_HOME", string>>;
}

const world = Effect.gen(function* world() {
	const copies = { claudePlugin: yield* pluginCopy, piPackage: yield* packageCopy };
	const fakeHarnessFolder = yield* fakeBin(copies);
	const { folders, root, xdg } = yield* rootFolders;
	const { checkedKeys, endpoint } = yield* keyMock;

	const env = Struct.assign(Struct.assign(folders, xdg), {
		NO_PROXY: "",
		PATH: `${fakeHarnessFolder}:/usr/bin:/bin`,
		PHI_ROUTER_KEY_CHECK_ENDPOINT: endpoint,
		no_proxy: "",
	});

	return { checkedKeys, copies, env, fakeHarnessFolder, folders, root, xdg };
});

interface TypedRan {
	readonly exitCode: number;
	readonly shown: string;
}

interface Typed {
	readonly after: string;
	readonly typed: string;
}

const entry = new URL("../../src/router/main.ts", import.meta.url).pathname;

const quotedCommandLine = (args: readonly string[]): string =>
	pipe(
		["bun", entry, ...args],
		Array.map((word) => `'${Str.replaceAll("'", String.raw`'\''`)(word)}'`),
		Array.join(" "),
	);

const typedRun = Effect.fnUntraced(function* typedRun(of: World, args: readonly string[], answers: readonly Typed[]) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const keyboard = yield* Queue.unbounded<string>();
	const screen = yield* Ref.make({ pending: answers, shown: "", shownSinceLastAnswer: "" });

	const command = ChildProcess.make("script", ["-qefc", quotedCommandLine(args), "/dev/null"], {
		env: of.env,
		extendEnv: true,
		stdin: Stream.encodeText(Stream.fromQueue(keyboard)),
	});

	const handle = yield* spawner.spawn(command);

	const read = Effect.fnUntraced(function* read(chunk: string) {
		const { pending, shown, shownSinceLastAnswer } = yield* Ref.updateAndGet(screen, (now) =>
			Struct.assign(now, {
				shown: now.shown + chunk,
				shownSinceLastAnswer: now.shownSinceLastAnswer + chunk,
			}),
		);

		if (!Array.isReadonlyArrayNonEmpty(pending)) {
			return;
		}

		const [next] = pending;

		if (Str.includes(next.after)(shownSinceLastAnswer)) {
			yield* Queue.offer(keyboard, `${next.typed}\r`);
			yield* Ref.set(screen, { pending: Array.tailNonEmpty(pending), shown, shownSinceLastAnswer: "" });
		}
	});

	yield* Stream.runForEach(Stream.decodeText(handle.stdout), read);

	const exitCode = yield* handle.exitCode;
	const { shown } = yield* Ref.get(screen);

	return { exitCode: Number(exitCode), shown: Str.replaceAll("\r\n", "\n")(shown) };
}, Effect.scoped);

const filesUnder = Effect.fnUntraced(function* filesUnder(folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const names = yield* fs.readDirectory(folder, { recursive: true }).pipe(Effect.orElseSucceed(() => []));

	const files = yield* Effect.filter(
		names,
		(name) => Effect.map(fs.stat(path.join(folder, name)), ({ type }) => type === "File"),
		{ concurrency: 1 },
	);

	return yield* Effect.forEach(
		Array.sort(files, Str.Order),
		Effect.fnUntraced(function* file(name) {
			const full = path.join(folder, name);
			const text = yield* fs.readFileString(full);
			const { mtime } = yield* fs.stat(full);

			return [full, text, String(mtime)] as const;
		}),
		{ concurrency: 1 },
	);
});

export { filesUnder, keys, typedRun, world };

export type { Typed, TypedRan, World };
