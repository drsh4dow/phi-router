import {
	Array,
	Effect,
	FileSystem,
	Formatter,
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
import manifest from "#package.json" with { type: "json" };
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

const signedOut = '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}';

const claudeStatus = ({ email, plan }: { readonly plan: string; readonly email: string }): string =>
	Formatter.formatJson({
		apiProvider: "firstParty",
		authMethod: "claude.ai",
		email,
		loggedIn: true,
		subscriptionType: plan,
	});

const installs = (copies: Copies): string => String.raw`const fs = require("fs");
const [harness, ...args] = process.argv.slice(2);
const version = ${Formatter.formatJson(manifest.version)};
const plugin = ${Formatter.formatJson(copies.claudePlugin)};
const json = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
const put = (file, value) => {
	fs.mkdirSync(require("path").dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2));
};
const fail = (line) => {
	console.error(line);
	process.exit(1);
};
if (harness === "claude") {
	const home = process.env.CLAUDE_CONFIG_DIR;
	const [knownFile, settingsFile, installsFile] = ["plugins/known_marketplaces.json", "settings.json", "plugins/installed_plugins.json"].map((name) => home + "/" + name);
	const [known, settings, installed] = [knownFile, settingsFile, installsFile].map(json);
	const plugins = installed.plugins || {};
	const at = (found) => put(installsFile, { version: 2, plugins: Object.assign(plugins, { "phi-router@phi-router": [{ installPath: plugin, scope: "user", version: found }] }) });
	const verb = args[1];
	if (verb === "install" && args.includes("--marketplace")) {
		const given = args[args.indexOf("--marketplace") + 1];
		const github = /^([\w.-]+\/[\w.-]+)@(.+)$/.exec(given);
		const source = github ? { source: "github", repo: github[1], ref: github[2] } : { source: "directory", path: given };
		const had = known["phi-router"];
		if (had && ["source", "repo", "ref", "path"].some((key) => had.source[key] !== source[key])) fail("Cannot add marketplace \"phi-router\": its source doesn't match its extraKnownMarketplaces entry");
		known["phi-router"] = { source, installLocation: home + "/plugins/marketplaces/phi-router" };
		settings.extraKnownMarketplaces = Object.assign({}, settings.extraKnownMarketplaces, { "phi-router": { source } });
		settings.enabledPlugins = Object.assign({}, settings.enabledPlugins, { "phi-router@phi-router": true });
		put(knownFile, known);
		put(settingsFile, settings);
	}
	if (!known["phi-router"]) fail("Marketplace not found");
	if (verb === "install" && !plugins["phi-router@phi-router"]) at(version);
	if (verb === "update") at(version);
}
if (harness === "codex") {
	const home = process.env.CODEX_HOME;
	const configFile = home + "/config.toml";
	const cache = home + "/plugins/cache/phi-router/phi-router";
	const config = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : "";
	const table = /\n*\[marketplaces\.phi-router\]\n([^[\n].*\n?)*/;
	const [, verb, step, given, , ref] = args;
	if (verb === "marketplace" && step === "add") {
		const from = ref ? 'source_type = "git"\nsource = "https://github.com/' + given + '.git"\nref = "' + ref + '"\n' : 'source_type = "local"\nsource = "' + given + '"\n';
		const block = "[marketplaces.phi-router]\n" + from;
		const had = table.exec(config);
		if (had && had[0].trim() !== block.trim()) fail("marketplace 'phi-router' is already added from a different source; remove it before adding this source");
		if (!had) fs.writeFileSync(configFile, config + "\n" + block);
	}
	if (verb === "marketplace" && step === "remove") {
		if (!table.test(config)) fail("marketplace phi-router is not configured or installed");
		fs.writeFileSync(configFile, config.replace(table, "\n"));
	}
	if (verb === "add") {
		fs.rmSync(cache, { recursive: true, force: true });
		fs.mkdirSync(cache, { recursive: true });
		fs.cpSync(plugin, cache + "/" + version, { recursive: true });
		if (!config.includes('[plugins."phi-router@phi-router"]')) fs.appendFileSync(configFile, ${Formatter.formatJson(enabled)});
	}
}
if (harness === "pi") {
	const home = process.env.PI_CODING_AGENT_DIR;
	const settingsFile = home + "/settings.json";
	const manifest = home + "/npm/node_modules/phi-router/package.json";
	const [verb, spec] = args;
	if (verb === "install") {
		const settings = json(settingsFile);
		settings.packages = (settings.packages || []).filter((entry) => !String(entry).startsWith("npm:phi-router")).concat([spec]);
		put(settingsFile, settings);
		if (!fs.existsSync(manifest)) put(manifest, { name: "phi-router", version });
	}
	if (verb === "update") put(manifest, { name: "phi-router", version });
}
`;

const hang = '[ -e "$here/hang" ] && { : > "$here/canary-ran"; exec sleep 30; }; [ -e "$here/fail" ] && exit 1';

const fakes: Readonly<Record<string, string>> = {
	claude: `case "$*" in
"auth status"*) cat "$CLAUDE_CONFIG_DIR/phi-fake-status.json" 2>/dev/null || { echo '${signedOut}'; exit 1; }; exit 0;;
"auth login"*) printf '%s\n' "$CLAUDE_CONFIG_DIR" >> "$here/logins"; if [ -n "$DISPLAY$BROWSER" ]; then printf '%s\n' "$CLAUDE_CONFIG_DIR" >> "$here/browser-launches"; else printf 'Paste code here if prompted > '; IFS= read -r code || exit 1; fi; cp "$here/next-sign-in.json" "$CLAUDE_CONFIG_DIR/phi-fake-status.json"; exit 0;;
"plugin "*) exec "$here/bun" "$here/installs.cjs" claude "$@";;
"") echo "claude started"; exit 0;;
esac
${hang}
exec "$here/bun" '${claudeStandIn}' "$@"`,
	codex: `case "$*" in
"login status") cat "$CODEX_HOME/phi-fake-login" 2>/dev/null || { echo "Not logged in" >&2; exit 1; }; exit 0;;
"plugin "*) exec "$here/bun" "$here/installs.cjs" codex "$@";;
"") echo "codex started"; exit 0;;
esac
${hang}
if [ -f "$CODEX_HOME/.env" ]; then set -a; . "$CODEX_HOME/.env"; set +a; fi; no_proxy=\${NO_PROXY-$no_proxy}
exec "$here/bun" '${codexStandIn}' "$@"`,
	pi: `case "$*" in
"--model phi/auto") echo "pi started"; exit 0;;
"-p "*) ${hang};;
"install npm:"*|"update npm:"*) exec "$here/bun" "$here/installs.cjs" pi "$@";;
esac
exec "$here/bun" '${piCli}' "$@"`,
};

const fakeBin = Effect.fnUntraced(function* fakeBin(copies: Copies) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const bin = yield* fs.makeTempDirectoryScoped({ prefix: "phi-setup-bin-" });
	const { printed: bun } = yield* ran(["bun", "-e", "process.stdout.write(process.execPath)"], {});

	yield* fs.symlink(bun, path.join(bin, "bun"));
	yield* fs.writeFileString(path.join(bin, "installs.cjs"), installs(copies));
	yield* fs.writeFileString(
		path.join(bin, "next-sign-in.json"),
		claudeStatus({ email: "roe@example.com", plan: "max" }),
	);

	yield* Effect.forEach(
		Record.toEntries(fakes),
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
	yield* fs.writeFileString(
		path.join(folders.CLAUDE_CONFIG_DIR, "phi-fake-status.json"),
		claudeStatus({ email: "you@example.com", plan: "max" }),
	);

	return { folders, root, xdg };
});

interface World {
	readonly checkedKeys: () => Effect.Effect<readonly string[]>;
	readonly copies: Copies;
	readonly env: Readonly<Record<string, string>>;
	readonly fakeHarnessFolder: string;
	readonly project: string;
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
		ANTHROPIC_API_KEY: "",
		BROWSER: "",
		CLAUDE_PID: "0",
		DISPLAY: "",
		NO_PROXY: "",
		OPENAI_API_KEY: "",
		PATH: `${fakeHarnessFolder}:/usr/bin:/bin`,
		PHI_ROUTER_CLAUDE_MANAGED_SETTINGS: `${root}/managed-settings.json`,
		PHI_ROUTER_KEY_CHECK_ENDPOINT: endpoint,
		WAYLAND_DISPLAY: "",
		no_proxy: "",
	});

	return { checkedKeys, copies, env, fakeHarnessFolder, folders, project: folders.HOME, root, xdg };
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

const escapeCode = 27;

const terminalCodes = new RegExp(String.raw`${String.fromCodePoint(escapeCode)}\[[\d;?]*[a-z]`, "giu");

const plain = (shown: string): string =>
	pipe(shown, Str.replaceAll(terminalCodes, ""), Str.replaceAll("\r", ""), Str.replaceAll("\u0007", ""));

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
		cwd: of.project,
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

	return { exitCode: Number(exitCode), shown: plain(shown) };
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

export { claudeStatus, filesUnder, keys, typedRun, world };

export type { Typed, TypedRan, World };
