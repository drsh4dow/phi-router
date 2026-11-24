import { Array, DateTime, Effect, FileSystem, Option, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import {
	codexFolders,
	codexIn,
	configFile,
	dotenvFile,
	exemptionLine,
	roleFile,
	settle,
	trusted,
	written,
} from "./configured.ts";
import { folder, phiRouter } from "#tools/claude/configured.ts";
import { NodeServices } from "@effect/platform-node";

const patient = { timeout: 30_000 };

const ok = 0;

const privateFile = 0o600;

const privateFolder = 0o700;

const sharedFile = 0o644;

const permissions = 0o1000;

const printedSettings = pipe(
	[
		'model_provider = "phi"',
		"features.unbounded_connection_retries = false",
		"feedback.enabled = false",
		'experimental_realtime_ws_base_url = "http://127.0.0.1:47411/v1"',
		'experimental_realtime_webrtc_call_base_url = "http://127.0.0.1:47411/v1"',
		'model_providers.phi.name = "phi-router"',
		'model_providers.phi.base_url = "http://127.0.0.1:47411/v1"',
		'model_providers.phi.wire_api = "responses"',
		"model_providers.phi.requires_openai_auth = true",
		"model_providers.phi.request_max_retries = 2",
		"model_providers.phi.stream_max_retries = 2",
	],
	Array.map((line) => `${line}\n  `),
);

const mustTrust = 'Trust the plugin\'s hooks: start codex and pick "Trust all and continue"';

const user = `# my Codex
model = "gpt-6-sol" # the default

[features]
goals = true

[model_providers.other]
base_url = "http://example.invalid/v1"
experimental_bearer_token = "sk-user-secret-value"

[feedback]
enabled = true # developer preference
other_key = "preserve me"

[profiles.fast]
model = "gpt-6-luna"
`;

const userOn = `# my Codex
model = "gpt-6-sol" # the default
model_provider = "phi" # phi-router
experimental_realtime_ws_base_url = "http://127.0.0.1:47411/v1" # phi-router
experimental_realtime_webrtc_call_base_url = "http://127.0.0.1:47411/v1" # phi-router

[features]
unbounded_connection_retries = false # phi-router
goals = true

[model_providers.other]
base_url = "http://example.invalid/v1"
experimental_bearer_token = "sk-user-secret-value"

[feedback]
enabled = false # phi-router
# phi-router kept: enabled = true # developer preference
other_key = "preserve me"

[profiles.fast]
model = "gpt-6-luna"

[model_providers.phi] # phi-router
name = "phi-router" # phi-router
base_url = "http://127.0.0.1:47411/v1" # phi-router
wire_api = "responses" # phi-router
requires_openai_auth = true # phi-router
request_max_retries = 2 # phi-router
stream_max_retries = 2 # phi-router
`;

const fresh = Effect.gen(function* fresh() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* codexFolders;
	const on = yield* phiRouter(codexIn(dir).on, env);
	const config = yield* fs.readFileString(configFile(dir));
	const dotenv = yield* fs.readFileString(dotenvFile(dir));
	const role = yield* fs.readFileString(roleFile(dir));

	const unprinted = pipe(
		[...printedSettings, `phi-router wrote ${exemptionLine} to ${dotenvFile(dir)}\n  `],
		Array.filter((line) => !Str.includes(line)(on.printed)),
	);

	assert.deepStrictEqual(
		{
			config,
			dotenv,
			exitCode: on.exitCode,
			mustTrust: Str.includes(mustTrust)(on.printed),
			named: Str.startsWith(`phi-router wrote 11 settings to ${configFile(dir)}\n`)(on.printed),
			unprinted,
		},
		{ config: written, dotenv: `${exemptionLine}\n`, exitCode: ok, mustTrust: true, named: true, unprinted: [] },
	);
	assert.include(role, 'name = "phi-sealed"\n');
	assert.include(role, 'model = "phi/sealed"\n');
}).pipe(Effect.scoped);

const trustedHook = Effect.gen(function* trustedHook() {
	const { dir, env } = yield* codexFolders;

	yield* settle(dir, trusted);

	const on = yield* phiRouter(codexIn(dir).on, env);

	assert.include(on.printed, "The plugin's hooks are trusted.");
	assert.notInclude(on.printed, mustTrust);
}).pipe(Effect.scoped);

const kept = Effect.gen(function* kept() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* codexFolders;

	yield* settle(dir, user);

	const bytes = fs.readFileString(configFile(dir));
	const [on, once] = yield* Effect.all([phiRouter(codexIn(dir).on, env), bytes], { concurrency: 1 });
	const twice = yield* phiRouter(codexIn(dir).on, env).pipe(Effect.andThen(bytes));
	const off = yield* phiRouter(codexIn(dir).off, env);
	const [after, role] = yield* Effect.all([bytes, fs.exists(roleFile(dir))], { concurrency: 1 });
	const printed = `${on.printed}${off.printed}`;

	assert.deepStrictEqual(
		{ after, once, printedSecret: Str.includes("sk-user-secret-value")(printed), role, twice },
		{ after: user, once: userOn, printedSecret: false, role: false, twice: userOn },
	);
}).pipe(Effect.scoped);

const inline = Effect.gen(function* inline() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* codexFolders;
	const before = "features = { goals = true }\n";

	yield* settle(dir, before);

	const on = yield* phiRouter(codexIn(dir).on, env);
	const after = yield* fs.readFileString(configFile(dir));
	const role = yield* fs.exists(roleFile(dir));

	assert.deepStrictEqual(
		{
			after,
			failed: on.exitCode !== ok,
			named: Str.includes("holds features as one inline table")(on.printed),
			role,
		},
		{ after: before, failed: true, named: true, role: false },
	);
}).pipe(Effect.scoped);

const holdsConfig = Effect.fnUntraced(function* holdsConfig(dirs: readonly string[]) {
	const fs = yield* FileSystem.FileSystem;

	return yield* Effect.forEach(dirs, (dir) => fs.exists(configFile(dir)), { concurrency: 1 });
});

const precedence = Effect.gen(function* precedence() {
	const flagged = yield* folder("phi-codex-flag-");
	const fromEnv = yield* folder("phi-codex-env-");
	const home = yield* folder("phi-codex-home-");
	const holding = holdsConfig([flagged, fromEnv, `${home}/.codex`]);
	const withEnv = { CODEX_HOME: fromEnv, HOME: home };
	const withHome = { CODEX_HOME: "", HOME: home };
	const byFlag = yield* phiRouter(codexIn(flagged).on, withEnv).pipe(Effect.andThen(holding));
	const byEnv = yield* phiRouter(["on", "codex"], withEnv).pipe(Effect.andThen(holding));
	const byHome = yield* phiRouter(["on", "codex"], withHome).pipe(Effect.andThen(holding));

	assert.deepStrictEqual(
		{ byEnv, byFlag, byHome },
		{ byEnv: [true, true, false], byFlag: [true, false, false], byHome: [true, true, true] },
	);
}).pipe(Effect.scoped);

const dotfiles = Effect.gen(function* dotfiles() {
	const fs = yield* FileSystem.FileSystem;
	const other = yield* folder("phi-codex-dotfiles-");

	yield* settle(other, user);
	yield* fs.chmod(configFile(other), sharedFile);

	return configFile(other);
});

const linked = Effect.gen(function* linked() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* codexFolders;
	const managed = yield* dotfiles;

	yield* fs.symlink(managed, configFile(dir));
	yield* phiRouter(codexIn(dir).on, env);

	const link = yield* fs.readLink(configFile(dir));
	const { mode } = yield* fs.stat(managed);
	const config = yield* fs.readFileString(managed);

	assert.deepStrictEqual(
		{ config, link, mode: mode % permissions },
		{ config: userOn, link: managed, mode: sharedFile },
	);
}).pipe(Effect.scoped);

const created = Effect.gen(function* created() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* codexFolders;
	const missing = `${dir}/missing`;
	const home = `${missing}/codex`;
	const on = yield* phiRouter(codexIn(home).on, env);

	const modes = yield* Effect.forEach(
		[missing, home, configFile(home), dotenvFile(home), `${home}/agents`, roleFile(home)],
		(made) => Effect.map(fs.stat(made), (info) => info.mode % permissions),
		{ concurrency: 1 },
	);

	assert.strictEqual(on.exitCode, ok, on.printed);
	assert.deepStrictEqual(modes, [privateFolder, privateFolder, privateFile, privateFile, privateFolder, privateFile]);
}).pipe(Effect.scoped);

const untouched = Effect.gen(function* untouched() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* codexFolders;
	const off = yield* phiRouter(codexIn(dir).off, env);
	const left = yield* fs.readDirectory(dir);

	assert.deepStrictEqual({ exitCode: off.exitCode, left }, { exitCode: ok, left: [] });
}).pipe(Effect.scoped);

const settledAt = DateTime.toDateUtc(DateTime.makeUnsafe("2001-01-01T00:00:00Z"));

const settledMtime = Option.some(settledAt.getTime());

const rerun = Effect.gen(function* rerun() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* codexFolders;
	const files = [configFile(dir), dotenvFile(dir), roleFile(dir)];

	yield* phiRouter(codexIn(dir).on, env);
	yield* Effect.forEach(files, (file) => fs.utimes(file, settledAt, settledAt), { concurrency: 1, discard: true });
	yield* phiRouter(codexIn(dir).on, env);

	const modified = yield* Effect.forEach(
		files,
		(file) =>
			Effect.map(fs.stat(file), (info) =>
				pipe(
					info.mtime,
					Option.map((at) => at.getTime()),
				),
			),
		{ concurrency: 1 },
	);

	assert.deepStrictEqual(modified, Array.replicate(settledMtime, files.length));
}).pipe(Effect.scoped);

const removedKeys = [
	"model_provider",
	"features.unbounded_connection_retries",
	"feedback.enabled",
	"experimental_realtime_ws_base_url",
	"experimental_realtime_webrtc_call_base_url",
	"[model_providers.phi]",
	"model_providers.phi.name",
	"model_providers.phi.base_url",
	"model_providers.phi.wire_api",
	"model_providers.phi.requires_openai_auth",
	"model_providers.phi.request_max_retries",
	"model_providers.phi.stream_max_retries",
];

const printedOff = Effect.gen(function* printedOff() {
	const { dir, env } = yield* codexFolders;

	yield* phiRouter(codexIn(dir).on, env);

	const first = yield* phiRouter(codexIn(dir).off, env);
	const second = yield* phiRouter(codexIn(dir).off, env);

	const removed = [
		`phi-router removed 12 settings from ${configFile(dir)}`,
		...removedKeys,
		`phi-router removed ${exemptionLine} from ${dotenvFile(dir)}`,
		`phi-router removed the role phi-sealed from ${roleFile(dir)}`,
	];

	assert.deepStrictEqual(
		{ first: first.printed, second: second.printed },
		{ first: `${Array.join(removed, "\n")}\n`, second: `phi-router removed 0 settings from ${configFile(dir)}\n` },
	);
}).pipe(Effect.scoped);

const changed = Effect.gen(function* changed() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* codexFolders;

	yield* phiRouter(codexIn(dir).on, env);

	const switched = Str.replace('model_provider = "phi" # phi-router', 'model_provider = "openai"')(written);

	yield* settle(dir, switched);
	yield* phiRouter(codexIn(dir).off, env);

	const after = yield* fs.readFileString(configFile(dir));

	assert.strictEqual(after, 'model_provider = "openai"\n');
}).pipe(Effect.scoped);

it.layer(NodeServices.layer)("on codex and off codex", (test) => {
	test.effect(
		"on writes exactly its eleven settings and the role into an empty home, prints each with a reason, and says the hook needs trust",
		() => fresh,
		patient,
	);
	test.effect("on says the hook is trusted when Codex stored its trust", () => trustedHook, patient);
	test.effect(
		"on keeps every other line and comment, a second on leaves the same bytes, and off gives the file back byte for byte",
		() => kept,
		patient,
	);
	test.effect(
		"on over a table held as one inline value exits non-zero, names it, and writes nothing",
		() => inline,
		patient,
	);
	test.effect("the home is the flag's, else CODEX_HOME, else .codex under HOME", () => precedence, patient);
	test.effect("on writes through a symlinked config.toml and keeps its 0644 mode", () => linked, patient);
	test.effect("on in a home that does not exist makes each folder 0700 and each file 0600", () => created, patient);
	test.effect("a second on writes no file", () => rerun, patient);
	test.effect(
		"off prints each setting, the exemption line and the role it removed, and a second off prints that it removed nothing",
		() => printedOff,
		patient,
	);
	test.effect("off in a home never switched on exits 0 and creates no file", () => untouched, patient);
	test.effect("off leaves a setting the user changed after on", () => changed, patient);
});
