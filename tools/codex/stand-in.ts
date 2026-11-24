import { Array, Config, Effect, FileSystem, Formatter, Option, Path, Schema, String as Str, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { codexBodyOf, sessionStartHooksRan, userMessage } from "#tools/route/harnesses.ts";

const ok = 200;

const session = "01a20000-0000-7000-8000-000000000022";

/** The trust Codex stores for the plugin's session-start hook, as `doctor codex` copies it. */
const trustTable = '[hooks.state."phi-router@phi-router:hooks/codex.json:session_start:0:0"]';

const Manifest = Schema.fromJsonString(Schema.Struct({ hooks: Schema.String }));

const valueIn = (config: string, key: string): Effect.Effect<string, string> => {
	const found = new RegExp(`^${key} = "(?<value>[^"]*)"$`, "mu").exec(config);

	return pipe(
		Option.fromNullishOr(found),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
		Option.map(({ value = "" }) => value),
		Effect.fromOption,
		Effect.mapError(() => `the stand-in codex found no ${key} in config.toml`),
	);
};

/** The plugin folders Codex would load: each `<marketplace>/<plugin>/<version>` of the cache with a manifest. */
const pluginFolders = Effect.fnUntraced(function* pluginFolders(codexHome: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const cache = path.join(codexHome, "plugins", "cache");
	const exists = yield* fs.exists(cache);

	if (!exists) {
		return [];
	}

	const files = yield* fs.readDirectory(cache, { recursive: true });

	return pipe(
		files,
		Array.filter(Str.endsWith(".codex-plugin/plugin.json")),
		Array.map((file) => path.join(cache, file, "..", "..")),
	);
});

const hooksRan = Effect.fnUntraced(function* hooksRan(folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const manifest = yield* fs.readFileString(path.join(folder, ".codex-plugin", "plugin.json"));
	const { hooks: file } = yield* Schema.decodeEffect(Manifest)(manifest);

	yield* sessionStartHooksRan({
		env: { PLUGIN_ROOT: folder },
		file: path.join(folder, file),
		input: Formatter.formatJson({
			cwd: process.cwd(),
			hook_event_name: "SessionStart",
			model: "phi/auto",
			permission_mode: "default",
			session_id: session,
			source: "startup",
		}),
	});
});

/**
 * A stand-in for `codex exec` in `check`, which has no real binary. It reads `$CODEX_HOME/config.toml`, runs the
 * SessionStart hooks of each installed plugin when the config holds the hook's trust or the run bypasses hook trust, as
 * `--dangerously-bypass-hook-trust` does, asks the provider's `base_url` for its model catalog as Codex does, posts one
 * streamed Responses request with the prompt there, reads the whole reply, and exits 0 when both were answered 200.
 */
const started = Effect.gen(function* started() {
	const fs = yield* FileSystem.FileSystem;
	const codexHome = yield* Config.String("CODEX_HOME");
	const config = yield* fs.readFileString(`${codexHome}/config.toml`);
	const folders = yield* pluginFolders(codexHome);

	if (Str.includes(trustTable)(config) || process.argv.includes("--dangerously-bypass-hook-trust")) {
		yield* Effect.forEach(folders, hooksRan, { concurrency: 1, discard: true });
	}

	return yield* valueIn(config, "base_url");
});

const codexHeaders = HttpClientRequest.setHeaders({
	authorization: "Bearer phi-doctor-login",
	"chatgpt-account-id": "phi-doctor-account",
	originator: "codex_exec",
	"session-id": session,
});

const program = Effect.gen(function* program() {
	const client = yield* HttpClient.HttpClient;
	const baseUrl = yield* started;
	const prompt = yield* Effect.fromOption(Array.last(process.argv));
	const body = yield* codexBodyOf([userMessage(prompt)]);

	const catalog = yield* client.execute(
		HttpClientRequest.get(`${baseUrl}/models?client_version=0.166.0`).pipe(codexHeaders),
	);

	yield* catalog.text;

	const request = HttpClientRequest.post(`${baseUrl}/responses`).pipe(
		codexHeaders,
		HttpClientRequest.bodyText(body, "application/json"),
	);

	const response = yield* client.execute(request);

	yield* response.text;

	return yield* Effect.filterOrFail(
		Effect.succeed([catalog.status, response.status]),
		Array.every((status) => status === ok),
		([listed, answered]) =>
			`the router answered the catalog with ${String(listed)} and the request with ${String(answered)}`,
	);
});

NodeRuntime.runMain(Effect.provide(program, [NodeServices.layer, FetchHttpClient.layer]));
