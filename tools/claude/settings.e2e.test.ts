import { Array, Effect, FileSystem, String as Str, Struct, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import {
	claudeFolders,
	claudeIn,
	folder,
	phiRouter,
	routed,
	settingsFile,
	settingsIn,
	settle,
	written,
} from "./configured.ts";
import type { ClaudeSettings } from "./configured.ts";
import { NodeServices } from "@effect/platform-node";

const patient = { timeout: 30_000 };

const ok = 0;

const printedSettings = pipe(
	Struct.keys(written),
	Array.map((name) => new RegExp(`^${name}=${written[name]}\n  \\S`, "mu")),
);

const reasons = [
	`no_proxy=${written.no_proxy}\n  Claude Code reaches the router without your proxy, which would see every prompt in plain HTTP.`,
	`PHI_ROUTER_WROTE_no_proxy=${written.PHI_ROUTER_WROTE_no_proxy}\n  phi-router off reads it to give no_proxy back as it was before on.\n`,
];

const others = { model: "opus", permissions: { allow: ["Read"] } };

const privateFile = 0o600;

const privateFolder = 0o700;

const sharedFile = 0o644;

const permissions = 0o1000;

const fresh = Effect.gen(function* fresh() {
	const { dir, env } = yield* claudeFolders;
	const on = yield* phiRouter(claudeIn(dir).on, env);
	const settings = yield* settingsIn(dir);

	const unprinted = pipe(
		printedSettings,
		Array.filter((line) => !line.test(on.printed)),
	);

	const unreasoned = pipe(
		reasons,
		Array.filter((reason) => !Str.includes(reason)(on.printed)),
	);

	assert.deepStrictEqual(
		{
			exitCode: on.exitCode,
			named: Str.startsWith(`phi-router wrote 10 settings to ${settingsFile(dir)}\n`)(on.printed),
			settings,
			unprinted,
			unreasoned,
		},
		{ exitCode: ok, named: true, settings: { env: written }, unprinted: [], unreasoned: [] },
	);
}).pipe(Effect.scoped);

const kept = Effect.gen(function* kept() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* claudeFolders;

	yield* settle(dir, Struct.assign(others, { env: { ANTHROPIC_BASE_URL: "http://old:1", FOO: "bar" } }));

	const bytes = fs.readFileString(settingsFile(dir));
	const once = yield* phiRouter(claudeIn(dir).on, env).pipe(Effect.andThen(bytes));
	const twice = yield* phiRouter(claudeIn(dir).on, env).pipe(Effect.andThen(bytes));
	const settings = yield* settingsIn(dir);

	assert.deepStrictEqual(settings, Struct.assign(others, { env: Struct.assign({ FOO: "bar" }, written) }));
	assert.strictEqual(twice, once);
}).pipe(Effect.scoped);

const holdsSettings = Effect.fnUntraced(function* holdsSettings(dirs: readonly string[]) {
	const fs = yield* FileSystem.FileSystem;

	return yield* Effect.forEach(dirs, (dir) => fs.exists(settingsFile(dir)), { concurrency: 1 });
});

const precedence = Effect.gen(function* precedence() {
	const flagged = yield* folder("phi-claude-flag-");
	const fromEnv = yield* folder("phi-claude-env-");
	const home = yield* folder("phi-claude-home-");
	const holding = holdsSettings([flagged, fromEnv, `${home}/.claude`]);
	const withEnv = { CLAUDE_CONFIG_DIR: fromEnv, HOME: home };
	const withHome = { CLAUDE_CONFIG_DIR: "", HOME: home };
	const byFlag = yield* phiRouter(claudeIn(flagged).on, withEnv).pipe(Effect.andThen(holding));
	const byEnv = yield* phiRouter(["on", "claude"], withEnv).pipe(Effect.andThen(holding));
	const byHome = yield* phiRouter(["on", "claude"], withHome).pipe(Effect.andThen(holding));

	assert.deepStrictEqual(
		{ byEnv, byFlag, byHome },
		{ byEnv: [true, true, false], byFlag: [true, false, false], byHome: [true, true, true] },
	);
}).pipe(Effect.scoped);

const unreadable = Effect.gen(function* unreadable() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* claudeFolders;
	const broken = '{ "env":';

	yield* fs.writeFileString(settingsFile(dir), broken);

	const on = yield* phiRouter(claudeIn(dir).on, env);
	const after = yield* fs.readFileString(settingsFile(dir));

	assert.deepStrictEqual(
		{ after, failed: on.exitCode !== ok, named: Str.includes(settingsFile(dir))(on.printed) },
		{ after: broken, failed: true, named: true },
	);
}).pipe(Effect.scoped);

const dotfiles = Effect.gen(function* dotfiles() {
	const fs = yield* FileSystem.FileSystem;
	const managed = yield* folder("phi-claude-dotfiles-");

	yield* settle(managed, others);
	yield* fs.chmod(settingsFile(managed), sharedFile);

	return managed;
});

const linked = Effect.gen(function* linked() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* claudeFolders;
	const folderKept = yield* dotfiles;
	const managed = settingsFile(folderKept);

	yield* fs.symlink(managed, settingsFile(dir));
	yield* phiRouter(claudeIn(dir).on, env);

	const link = yield* fs.readLink(settingsFile(dir));
	const { mode } = yield* fs.stat(managed);
	const settings = yield* settingsIn(folderKept);

	assert.deepStrictEqual(
		{ link, mode: mode % permissions, settings },
		{ link: managed, mode: sharedFile, settings: Struct.assign(others, { env: written }) },
	);
}).pipe(Effect.scoped);

const created = Effect.gen(function* created() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* claudeFolders;
	const missing = `${dir}/missing`;
	const config = `${missing}/claude`;
	const on = yield* phiRouter(claudeIn(config).on, env);

	const modes = yield* Effect.forEach(
		[missing, config, settingsFile(config)],
		(made) => Effect.map(fs.stat(made), (info) => info.mode % permissions),
		{ concurrency: 1 },
	);

	assert.strictEqual(on.exitCode, ok, on.printed);
	assert.deepStrictEqual(modes, [privateFolder, privateFolder, privateFile]);
}).pipe(Effect.scoped);

const restored = Effect.fnUntraced(function* restored(before: ClaudeSettings) {
	const { dir, env } = yield* claudeFolders;

	yield* settle(dir, before);
	yield* phiRouter(claudeIn(dir).on, env);

	const off = yield* phiRouter(claudeIn(dir).off, env);
	const after = yield* settingsIn(dir);

	assert.strictEqual(off.exitCode, ok, off.printed);
	assert.deepStrictEqual<unknown>(after, before);
}, Effect.scoped);

const edited = Effect.gen(function* edited() {
	const { dir, env } = yield* claudeFolders;
	const before = { env: { no_proxy: "corp.example" } };

	const changedSinceOn = Struct.assign(routed, {
		ANTHROPIC_BASE_URL: "http://127.0.0.1:47412",
		DISABLE_TELEMETRY: "0",
		PHI_ROUTER_REPLACED_no_proxy: "corp.example",
		PHI_ROUTER_WROTE_no_proxy: "corp.example,127.0.0.1:47411",
		no_proxy: "corp.example,127.0.0.1:47411",
	});

	yield* settle(dir, { env: changedSinceOn });

	const off = yield* phiRouter(claudeIn(dir).off, env);
	const after = yield* settingsIn(dir);

	const printed = [
		`phi-router removed 8 settings from ${settingsFile(dir)}`,
		...Struct.keys(routed),
		"phi-router gave no_proxy back as it was before on",
	];

	const lines = Str.split("\n")(Str.trimEnd(off.printed));

	assert.deepStrictEqual(
		{ after, printed: Array.sort(lines, Str.Order) },
		{ after: before, printed: Array.sort(printed, Str.Order) },
	);
}).pipe(Effect.scoped);

const untouched = Effect.gen(function* untouched() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* claudeFolders;
	const off = yield* phiRouter(claudeIn(dir).off, env);
	const left = yield* fs.readDirectory(dir);

	assert.deepStrictEqual({ exitCode: off.exitCode, left }, { exitCode: ok, left: [] });
}).pipe(Effect.scoped);

it.layer(NodeServices.layer)("on claude and off claude", (test) => {
	test.effect(
		"on writes exactly the ten settings into an empty folder and prints each with a reason, no_proxy's the exemption's and its record's the one off reads",
		() => fresh,
		patient,
	);
	test.effect(
		"on keeps every other key and replaces an old address, and a second on leaves the same bytes",
		() => kept,
		patient,
	);
	test.effect("the folder is the flag's, else CLAUDE_CONFIG_DIR, else .claude under HOME", () => precedence, patient);
	test.effect(
		"on over a settings.json it cannot read exits non-zero, names it and leaves its bytes",
		() => unreadable,
		patient,
	);
	test.effect("on writes through a symlinked settings.json and keeps its 0644 mode", () => linked, patient);
	test.effect(
		"on in a config folder that does not exist makes each folder 0700 and settings.json 0600",
		() => created,
		patient,
	);
	test.effect.each([Struct.assign(others, { env: { FOO: "bar" } }), { model: "opus" }])(
		"off after on gives back every other key as it was in %j",
		restored,
		patient,
	);
	test.effect(
		"off removes each setting on wrote whatever its value now, gives no_proxy back, and prints the names it removed",
		() => edited,
		patient,
	);
	test.effect("off in a folder never switched on exits 0 and creates no file", () => untouched, patient);
});
