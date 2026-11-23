import { Array, Effect, FileSystem, Path, Record, Schema, String as Str, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** The fake credentials of the account tests. A test fails when any of them shows in an XDG folder or in what was printed. */
const tokens = {
	claudeFolder: "phi-test-claude-folder-token",
	codexFolder: "phi-test-codex-folder-token",
	command: "sk-ant-oat01-phi-test-token-command",
	key: "sk-phi-test-openai-key",
} as const;

const later = 4_102_444_800_000;

const judge = { endpoint: "http://127.0.0.1:9/v1", keyEnv: "PHI_TEST_JUDGE_KEY" };

const configs = {
	both: {
		clean: [
			{ forwarded: true, name: "claude-1", vendor: "anthropic" },
			{ forwarded: true, name: "codex", vendor: "openai" },
		],
		judge,
		note: "kept as it was",
		sealed: [
			{ forwarded: true, name: "enterprise", vendor: "anthropic" },
			{ keyEnv: "PHI_TEST_BAA_KEY", name: "openai", scheme: "apiKey", vendor: "openai" },
		],
		targetModel: { anthropic: "claude-target", openai: "gpt-target" },
	},
	claudeOnly: {
		clean: [{ forwarded: true, name: "claude-1", vendor: "anthropic" }],
		judge,
		sealed: [{ forwarded: true, name: "enterprise", vendor: "anthropic" }],
		targetModel: { anthropic: "claude-target" },
	},
	lacking: {
		clean: [{ forwarded: true, name: "claude-1", vendor: "anthropic" }],
		judge,
		sealed: [
			{ forwarded: true, lacks: ["claude-haiku-5-5", "claude-sonnet-5-5"], name: "enterprise", vendor: "anthropic" },
			{ keyEnv: "PHI_TEST_BAA_KEY", name: "enterprise-2", scheme: "apiKey", vendor: "anthropic" },
		],
		sealedModel: { anthropic: "claude-sealed" },
		targetModel: { anthropic: "claude-target" },
	},
} as const;

const JsonText = Schema.fromJsonString(Schema.Json);

const Entries = Schema.Array(Schema.Record(Schema.String, Schema.Json));

/** A `config.json` as a test reads it: its lanes' entries, and every other field as it is. */
const ConfigFile = Schema.fromJsonString(
	Schema.StructWithRest(Schema.Struct({ clean: Entries, sealed: Entries }), [
		Schema.Record(Schema.String, Schema.Json),
	]),
);

/** One test's folders and the commands that print its fake Claude token and its fake OpenAI key. */
interface Prepared {
	readonly configFile: string;
	readonly env: { readonly TZ: string; readonly XDG_CONFIG_HOME: string; readonly XDG_STATE_HOME: string };
	readonly folders: { readonly claude: string; readonly codex: string; readonly none: string };
	readonly commands: { readonly key: string; readonly token: string };
	readonly state: string;
}

/**
 * What a Claude login writes in `.credentials.json`, with the fake folder token.
 *
 * @param {number} ends When its access token expires and its login ends, in epoch milliseconds.
 * @returns {string} The file's text.
 */
const claudeCredentials = (ends: number): string =>
	`{"claudeAiOauth":{"accessToken":"${tokens.claudeFolder}","expiresAt":${String(ends)},"refreshTokenExpiresAt":${String(ends)}}}`;

const loginsIn = Effect.fnUntraced(function* loginsIn(outside: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const folders = {
		claude: path.join(outside, "claude"),
		codex: path.join(outside, "codex"),
		none: path.join(outside, "none"),
	};

	const codex = `{"auth_mode":"chatgpt","tokens":{"access_token":"${tokens.codexFolder}","account_id":"phi-test-account"}}`;

	yield* Effect.forEach(Record.values(folders), (folder) => fs.makeDirectory(folder), { concurrency: 1 });
	yield* fs.writeFileString(path.join(folders.claude, ".credentials.json"), claudeCredentials(later));
	yield* fs.writeFileString(path.join(folders.codex, "auth.json"), codex);
	yield* fs.writeFileString(path.join(outside, "token"), `${tokens.command}\n`);
	yield* fs.writeFileString(path.join(outside, "key"), `${tokens.key}\n`);

	return folders;
});

/** Fresh XDG config and state folders, `config.json` holding the config `name`, and the logins outside both. */
const prepared = Effect.fnUntraced(function* prepared(name: keyof typeof configs) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const xdgConfig = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-config-" });
	const xdgState = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-state-" });
	const outside = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-logins-" });
	const configFile = path.join(xdgConfig, "phi-router", "config.json");
	const text = yield* Schema.encodeEffect(JsonText)(configs[name]);

	yield* fs.makeDirectory(path.dirname(configFile));
	yield* fs.writeFileString(configFile, text);

	return {
		commands: { key: `cat '${path.join(outside, "key")}'`, token: `cat '${path.join(outside, "token")}'` },
		configFile,
		env: { TZ: "UTC", XDG_CONFIG_HOME: xdgConfig, XDG_STATE_HOME: xdgState },
		folders: yield* loginsIn(outside),
		state: path.join(xdgState, "phi-router"),
	} satisfies Prepared;
});

/** Runs `phi-router` from the repository in `env`: its exit code and what it printed on each stream. */
const phiRouter = Effect.fnUntraced(function* phiRouter(
	env: Readonly<Record<string, string>>,
	args: readonly string[],
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const path = yield* Path.Path;
	const cwd = path.resolve(import.meta.dirname, "../..");
	const command = ChildProcess.make("bun", ["src/router/main.ts", ...args], { cwd, env, extendEnv: true });
	const handle = yield* spawner.spawn(command);

	const [stdout, stderr] = yield* Effect.all(
		[Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
		{ concurrency: 2 },
	);

	const exitCode = yield* handle.exitCode;

	return { exitCode: Number(exitCode), stderr, stdout };
}, Effect.scoped);

const holdsToken = (text: string): boolean =>
	pipe(
		Record.values(tokens),
		Array.some((token) => Str.includes(token)(text)),
	);

/** Every file under `roots`, and every one of `printed`, that holds a fake token. */
const leaks = Effect.fnUntraced(function* leaks(roots: readonly string[], printed: readonly string[]) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const names = yield* Effect.forEach(
		roots,
		(root) =>
			Effect.map(
				fs.readDirectory(root, { recursive: true }),
				Array.map((name) => path.join(root, name)),
			),
		{ concurrency: 1 },
	);

	const files = yield* Effect.forEach(
		Array.flatten(names),
		(file) =>
			Effect.map(
				Effect.orElseSucceed(fs.readFileString(file), () => ""),
				(text) => ({ file, text }),
			),
		{ concurrency: 1 },
	);

	const texts = [
		...files,
		...pipe(
			printed,
			Array.map((text) => ({ file: "printed", text })),
		),
	];

	return pipe(
		texts,
		Array.filter(({ text }) => holdsToken(text)),
		Array.map(({ file }) => file),
	);
});

export { ConfigFile, JsonText, claudeCredentials, leaks, phiRouter, prepared, tokens };

export type { Prepared };
