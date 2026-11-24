import { Effect, FileSystem, Path, Schedule } from "effect";
import {
	argsOf,
	callsOf,
	claudeAnswers,
	filesSetupMayChange,
	keyAnswer,
	keyFiles,
	layer,
	ok,
	ownSettings,
	patient,
	setUp,
	writeOwnSettings,
} from "./set-up.ts";
import { assert, it } from "@effect/vitest";
import { filesUnder, keys, typedRun, world } from "./world.ts";
import type { World } from "./world.ts";
import { phiRouter } from "#tools/cli/accounts-run.ts";

interface BadKey {
	readonly copy: string;
	readonly kind: string;
	readonly pasted: string;
}

const badKeys: readonly BadKey[] = [
	{
		copy: "That is a Claude subscription token, not an API key. Setup needs the API key your organization gave you for patient data. Nothing was saved. Paste a key that starts with sk-ant-api.",
		kind: "a subscription token",
		pasted: keys.subscription,
	},
	{
		copy: "That is an OpenAI key. Claude Code needs an Anthropic key, which starts with sk-ant-api. Nothing was saved.",
		kind: "an OpenAI key",
		pasted: keys.openai,
	},
	{
		copy: "Anthropic refused that key. Nothing was saved or changed. Check it with whoever gave it to you, then rerun the command.",
		kind: "a key Anthropic refuses",
		pasted: keys.refused,
	},
];

const badKey = Effect.fnUntraced(function* badKey({ copy, pasted }: BadKey) {
	const of = yield* world;

	yield* writeOwnSettings(of);

	const before = yield* filesSetupMayChange(of);
	const run = yield* setUp(of, "claude", [{ after: "Key: ", typed: pasted }]);
	const after = yield* filesSetupMayChange(of);

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.include(run.shown, copy);
	assert.deepStrictEqual(after, before, "no key file, no config.json and no harness setting");

	const claudeArgs = yield* argsOf(of, "claude");

	assert.deepStrictEqual(claudeArgs, [], "nothing installed");
}, Effect.scoped);

const noTerminal = Effect.gen(function* noTerminal() {
	const of = yield* world;
	const before = yield* filesSetupMayChange(of);
	const run = yield* phiRouter(of.env, ["setup", "claude"]);
	const after = yield* filesSetupMayChange(of);

	assert.notStrictEqual(run.exitCode, ok);
	assert.include(
		run.stderr,
		"phi-router setup asks for a key, so it needs your own terminal. Run it yourself, outside your coding agent. Nothing was changed.",
	);
	assert.deepStrictEqual(after, before);
}).pipe(Effect.scoped);

const endOfInput = "\u0004";

const endedAtKey = Effect.gen(function* endedAtKey() {
	const of = yield* world;

	yield* writeOwnSettings(of);

	const before = yield* filesSetupMayChange(of);
	const run = yield* setUp(of, "claude", [{ after: "Key: ", typed: endOfInput }]);
	const after = yield* filesSetupMayChange(of);

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.include(run.shown, "Setup ended before it got a key. Nothing was saved or changed.");
	assert.deepStrictEqual(after, before);
}).pipe(Effect.scoped);

const broken = Effect.fnUntraced(function* broken(of: World, how: "hang" | "fail") {
	const fs = yield* FileSystem.FileSystem;

	yield* writeOwnSettings(of);
	yield* fs.writeFileString(`${of.fakeHarnessFolder}/${how}`, "");
});

const untouched = Effect.fnUntraced(function* untouched(of: World) {
	const fs = yield* FileSystem.FileSystem;
	const calls = yield* callsOf(of, "claude");
	const settings = yield* fs.readFileString(`${of.folders.CLAUDE_CONFIG_DIR}/settings.json`);

	assert.deepStrictEqual(calls, ["test"], "nothing installed");
	assert.strictEqual(settings, ownSettings);
});

const failedTest = Effect.gen(function* failedTest() {
	const of = yield* world;

	yield* broken(of, "fail");

	const before = yield* filesUnder(of.folders.CLAUDE_CONFIG_DIR);
	const run = yield* setUp(of, "claude", [keyAnswer]);
	const after = yield* filesUnder(of.folders.CLAUDE_CONFIG_DIR);

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.include(
		run.shown,
		"The test failed, so Claude Code was left as it was. Your key is saved. For details, run: npx phi-router doctor claude",
	);
	assert.deepStrictEqual(after, before, "Claude Code's folder as it was");
	yield* untouched(of);
}).pipe(Effect.scoped);

const hollowInstaller = Effect.fnUntraced(function* hollowInstaller(of: World) {
	const fs = yield* FileSystem.FileSystem;
	const claude = `${of.fakeHarnessFolder}/claude`;

	yield* fs.rename(claude, `${of.fakeHarnessFolder}/claude-real`);
	yield* fs.writeFileString(
		claude,
		`#!/bin/sh\ncase "$1" in plugin) printf '%s\\n' "$*" >> "\${0%/*}/claude-args"; exit 0;; esac\nexec "\${0%/*}/claude-real" "$@"\n`,
		{ mode: 0o755 },
	);
});

const hollowInstall = Effect.gen(function* hollowInstall() {
	const fs = yield* FileSystem.FileSystem;
	const of = yield* world;

	yield* writeOwnSettings(of);
	yield* hollowInstaller(of);

	const run = yield* setUp(of, "claude", claudeAnswers);
	const calls = yield* callsOf(of, "claude");
	const settings = yield* fs.readFileString(`${of.folders.CLAUDE_CONFIG_DIR}/settings.json`);

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.include(run.shown, "Claude Code did not install phi-router. Your key is saved.");
	assert.deepStrictEqual(calls, ["test", "install"], "nothing runs after the install");
	assert.strictEqual(settings, ownSettings, "Claude Code is not switched on");
}).pipe(Effect.scoped);

interface SavedKey {
	readonly flags: readonly string[];
	readonly kind: string;
	readonly saved: string;
}

const askedAgainFor: readonly SavedKey[] = [
	{ flags: ["--new-key"], kind: "--new-key, though Anthropic accepts the saved key", saved: keys.anthropic },
	{ flags: [], kind: "Anthropic now refuses the saved key", saved: keys.refused },
];

const askedAgain = Effect.fnUntraced(function* askedAgain({ flags, saved }: SavedKey) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const of = yield* world;
	const { anthropic } = keyFiles(of);

	yield* broken(of, "fail");
	yield* fs.makeDirectory(path.dirname(anthropic), { recursive: true });
	yield* fs.writeFileString(anthropic, `${saved}\n`);

	const run = yield* typedRun(of, ["setup", "claude", ...flags], [{ after: "Key: ", typed: keys.subscription }]);

	assert.include(run.shown, "Your BAA account           needs an API key", run.shown);
	assert.include(run.shown, "Paste the Anthropic API key your organization gave you for patient data.");
}, Effect.scoped);

const stopped = Effect.gen(function* stopped() {
	const fs = yield* FileSystem.FileSystem;
	const of = yield* world;

	yield* broken(of, "hang");

	const canaryRan = fs
		.exists(`${of.fakeHarnessFolder}/canary-ran`)
		.pipe(Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: Boolean }));

	const run = setUp(of, "claude", [keyAnswer]);
	const ended = yield* Effect.raceFirst(Effect.as(run, "ended"), Effect.as(canaryRan, "killed"));

	yield* Effect.sleep("1 second");

	assert.strictEqual(ended, "killed", "setup was killed while its test ran");
	yield* untouched(of);
}).pipe(Effect.scoped);

it.layer(layer)("setup refused", (test) => {
	test.effect.each(badKeys)("a bad key changes nothing: $kind", badKey, patient);
	test.effect("setup with no terminal says so and changes nothing", () => noTerminal, patient);
	test.effect("input that ends at the key question saves and changes nothing", () => endedAtKey, patient);
	test.effect("a failed test installs nothing and leaves Claude Code's folder as it was", () => failedTest, patient);
	test.effect("an installer that exits 0 but installs nothing stops setup", () => hollowInstall, patient);
	test.effect.each(askedAgainFor)("setup asks for a key again when $kind", askedAgain, patient);
});

it.layer(layer, { excludeTestServices: true })("setup stopped, on the real clock", (test) => {
	test.effect("a setup stopped during its test leaves Claude Code's settings byte for byte", () => stopped, patient);
});
