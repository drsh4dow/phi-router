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
import { packageCopy, pluginCopy } from "#tools/plugin/copied.ts";
import { NodeHttpServer } from "@effect/platform-node";
import { enabled } from "#tools/codex/configured.ts";
import { ran } from "#tools/lifecycle/launched.ts";

/** The keys a test pastes. The key mock accepts the first two and refuses the rest. */
const keys = {
	anthropic: "sk-ant-api03-phi-test-baa-key",
	openai: "sk-proj-phi-test-openai-key",
	refused: "sk-ant-api03-phi-test-refused-key",
	subscription: "sk-ant-oat01-phi-test-subscription-token",
} as const;

const accepted: ReadonlySet<string> = new Set([keys.anthropic, keys.openai]);

const statuses = { ok: 200, unauthorized: 401 } as const;

/** A vendor's `GET /v1/models`, which answers 200 to an accepted key in either vendor's header and 401 to the rest. */
const keyMock = Effect.gen(function* keyMock() {
	const server = yield* Layer.build(NodeHttpServer.layerTest);

	const answer = Effect.gen(function* answer() {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const bearer = Str.replace(/^Bearer /u, "")(request.headers["authorization"] ?? "");
		const key = request.headers["x-api-key"] ?? bearer;

		if (accepted.has(key)) {
			return HttpServerResponse.empty({ status: statuses.ok });
		}

		return HttpServerResponse.empty({ status: statuses.unauthorized });
	});

	return yield* Effect.provideContext(
		Effect.gen(function* serve() {
			const http = yield* HttpServer.HttpServer;

			yield* http.serve(answer);

			return HttpServer.formatAddress(http.address);
		}),
		server,
	);
});

const claudeStandIn = new URL("../claude/stand-in.ts", import.meta.url).pathname;

const codexStandIn = new URL("../codex/stand-in.ts", import.meta.url).pathname;

const piCli = decodeURIComponent(
	new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url).pathname,
);

/** The copies of `plugins/claude` and the pi package that setup installs from with `--source`. */
interface Copies {
	readonly pkg: string;
	readonly plugin: string;
}

/**
 * The fake harnesses. Each appends the arguments it gets to `<name>-args` beside it. Its installer commands write what
 * the real ones write: Claude Code's turns the plugin on in its settings and records the marketplace, Codex's adds the
 * marketplace and the enabled plugin to `config.toml`, and pi's is the pinned pi. Its canary turn runs the stand-in, or
 * the pinned pi, and a bare start prints `<name> started`. While `hang` exists beside it, its canary turn says so in
 * `canary-ran` and waits. While `fail` exists, its canary turn fails.
 *
 * @param {Copies} copies What the installer commands copy.
 * @returns {Readonly<Record<string, string>>} Each harness's script body, by name.
 */
const fakes = (copies: Copies): Readonly<Record<string, string>> => {
	const installedPlugins = `{"version":2,"plugins":{"phi-router@phi-router":[{"installPath":"${copies.plugin}","scope":"user"}]}}`;
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
"plugin add "*) mkdir -p ${cache}; cp -R '${copies.plugin}' ${cache}/0.1.0; printf '%s' '${enabled}' >> "$CODEX_HOME/config.toml"; exit 0;;
"") echo "codex started"; exit 0;;
esac
${hang}
if [ -f "$CODEX_HOME/.env" ]; then set -a; . "$CODEX_HOME/.env"; set +a; fi; no_proxy=\${NO_PROXY-$no_proxy}
exec "$here/bun" '${codexStandIn}' "$@"`,
		pi: `case "$*" in
"--model phi/auto") echo "pi started"; exit 0;;
"-p "*) ${hang};;
esac
exec "$here/bun" '${piCli}' "$@"`,
	};
};

/** A fresh `bin` folder with the fake harnesses and a link to `bun`. */
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

/** A fresh root folder with the home and each harness's folder made in it, and the XDG folders named under it. */
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

/**
 * One test's world: a root folder that holds the home, each harness's folder and the XDG folders, a `bin` beside it
 * with the fake harnesses and `bun`, the key mock, the environment that names them all, and the copies setup installs
 * from with `--source`.
 */
interface World {
	readonly bin: string;
	readonly copies: Copies;
	readonly env: Readonly<Record<string, string>>;
	readonly folders: Readonly<Record<"CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "PI_CODING_AGENT_DIR", string>>;
	readonly root: string;
	readonly xdg: Readonly<Record<"XDG_CACHE_HOME" | "XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_STATE_HOME", string>>;
}

/** Builds one test's {@link World} for the test's scope. */
const world = Effect.gen(function* world() {
	const copies = { pkg: yield* packageCopy, plugin: yield* pluginCopy };
	const bin = yield* fakeBin(copies);
	const { folders, root, xdg } = yield* rootFolders;
	const endpoint = yield* keyMock;

	const env = Struct.assign(Struct.assign(folders, xdg), {
		NO_PROXY: "",
		PATH: `${bin}:/usr/bin:/bin`,
		PHI_ROUTER_KEY_CHECK_ENDPOINT: endpoint,
		no_proxy: "",
	});

	return { bin, copies, env, folders, root, xdg };
});

/** What the terminal showed in a {@link typedRun}, and its exit code. */
interface TypedRan {
	readonly exitCode: number;
	readonly shown: string;
}

/** One answer a test types once the screen shows `after`, Enter included. */
interface Typed {
	readonly after: string;
	readonly typed: string;
}

const entry = new URL("../../src/router/main.ts", import.meta.url).pathname;

/**
 * The text that runs `bun <entry> args` in a POSIX shell, each word quoted.
 *
 * @param {readonly string[]} args The arguments.
 * @returns {string} The command line.
 */
const commandLine = (args: readonly string[]): string =>
	pipe(
		["bun", entry, ...args],
		Array.map((word) => `'${Str.replaceAll("'", String.raw`'\''`)(word)}'`),
		Array.join(" "),
	);

/**
 * Runs `phi-router` with `args` in a pseudo-terminal through `script`, as a human runs it, and types each answer once
 * the screen shows its `after` text past the last answer's. Gives what the terminal showed and the exit code. Its
 * scope ends the run.
 */
const typedRun = Effect.fnUntraced(function* typedRun(of: World, args: readonly string[], answers: readonly Typed[]) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const keyboard = yield* Queue.unbounded<string>();
	const screen = yield* Ref.make({ pending: answers, seen: "", shown: "" });

	const command = ChildProcess.make("script", ["-qefc", commandLine(args), "/dev/null"], {
		env: of.env,
		extendEnv: true,
		stdin: Stream.encodeText(Stream.fromQueue(keyboard)),
	});

	const handle = yield* spawner.spawn(command);

	const read = Effect.fnUntraced(function* read(chunk: string) {
		const { pending, seen, shown } = yield* Ref.updateAndGet(screen, (now) =>
			Struct.assign(now, { seen: now.seen + chunk, shown: now.shown + chunk }),
		);

		if (!Array.isReadonlyArrayNonEmpty(pending)) {
			return;
		}

		const [next] = pending;

		if (Str.includes(next.after)(seen)) {
			yield* Queue.offer(keyboard, `${next.typed}\r`);
			yield* Ref.set(screen, { pending: Array.tailNonEmpty(pending), seen: "", shown });
		}
	});

	yield* Stream.runForEach(Stream.decodeText(handle.stdout), read);

	const exitCode = yield* handle.exitCode;
	const { shown } = yield* Ref.get(screen);

	return { exitCode: Number(exitCode), shown: Str.replaceAll("\r\n", "\n")(shown) };
}, Effect.scoped);

/** Every file under `folder`, by path, with its bytes and its modification time. */
const snapshot = Effect.fnUntraced(function* snapshot(folder: string) {
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

export { keys, snapshot, typedRun, world };

export type { Typed, TypedRan, World };
