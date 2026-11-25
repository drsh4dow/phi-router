import { Effect, FileSystem, Formatter, Path, Schedule } from "effect";
import type { Typed, World } from "./world.ts";
import { assert, it } from "@effect/vitest";
import {
	baaKey,
	callsOf,
	endOfInput,
	enter,
	judgeKey,
	keyFiles,
	keyPicked,
	lastLine,
	layer,
	maxAnswers,
	noAnother,
	ok,
	ownSettings,
	patient,
	questions,
	setUp,
	tracked,
	writeOwnSettings,
} from "./set-up.ts";
import { filesUnder, keys, typedRun, world } from "./world.ts";

const anthropicKeyQuestion = "Anthropic key (BAA)";

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

	const { after, before, run } = yield* tracked(
		of,
		["setup", "claude"],
		[keyPicked, noAnother, { after: anthropicKeyQuestion, typed: pasted }, judgeKey],
	);

	const calls = yield* callsOf(of, "claude");

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.strictEqual(lastLine(run.shown), copy);
	assert.deepStrictEqual(after, before, "no key file, no config.json and no harness setting");
	assert.deepStrictEqual(calls, [], "nothing tested or installed");
}, Effect.scoped);

interface EndedAt {
	readonly kind: string;
	readonly answers: readonly Typed[];
}

const endedAt: readonly EndedAt[] = [
	{ answers: [{ after: questions.baa, typed: endOfInput }], kind: "a pick" },
	{ answers: [keyPicked, noAnother, { after: anthropicKeyQuestion, typed: endOfInput }], kind: "a key" },
];

const ended = Effect.fnUntraced(function* ended({ answers }: EndedAt) {
	const of = yield* world;

	yield* writeOwnSettings(of);

	const { after, before, run } = yield* tracked(of, ["setup", "claude"], answers);

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.strictEqual(lastLine(run.shown), "Setup ended before it finished. Nothing was saved or changed.");
	assert.deepStrictEqual(after, before);
}, Effect.scoped);

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
	const run = yield* setUp(of, "claude", maxAnswers);
	const after = yield* filesUnder(of.folders.CLAUDE_CONFIG_DIR);

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.strictEqual(
		lastLine(run.shown),
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

	const run = yield* setUp(of, "claude", maxAnswers);
	const calls = yield* callsOf(of, "claude");
	const settings = yield* fs.readFileString(`${of.folders.CLAUDE_CONFIG_DIR}/settings.json`);

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.strictEqual(lastLine(run.shown), "Claude Code did not install phi-router. Your key is saved.");
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

const setUpBefore = Effect.fnUntraced(function* setUpBefore(of: World, saved: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const { anthropic, openai } = keyFiles(of);

	const config = {
		clean: [{ forwarded: true, name: "claude-1", vendor: "anthropic" }],
		judge: { endpoint: "https://api.openai.com/v1", keyFile: openai },
		sealed: [{ keyFile: anthropic, name: "claude-2", scheme: "apiKey", vendor: "anthropic" }],
	};

	yield* fs.makeDirectory(path.dirname(anthropic), { recursive: true });
	yield* fs.writeFileString(anthropic, `${saved}\n`);
	yield* fs.writeFileString(openai, `${keys.openai}\n`);
	yield* fs.writeFileString(`${of.xdg.XDG_CONFIG_HOME}/phi-router/config.json`, Formatter.formatJson(config));
});

const askedAgain = Effect.fnUntraced(function* askedAgain({ flags, saved }: SavedKey) {
	const fs = yield* FileSystem.FileSystem;
	const of = yield* world;

	yield* setUpBefore(of, saved);

	const config = `${of.xdg.XDG_CONFIG_HOME}/phi-router/config.json`;
	const before = yield* fs.readFileString(config);
	const run = yield* typedRun(of, ["setup", "claude", ...flags], [baaKey, enter]);
	const after = yield* fs.readFileString(config);
	const key = yield* fs.readFileString(keyFiles(of).anthropic);

	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.include(run.shown, "  Patient data    needs a new key\n  PHI check       OpenAI   ✓\n", run.shown);
	assert.notInclude(run.shown, questions.baa, "no pick: the new key replaces the old one");
	assert.strictEqual(key, `${keys.anthropic}\n`, "the new key is saved over the old one");
	assert.strictEqual(after, before, "config.json already names the key file");
}, Effect.scoped);

const stopped = Effect.gen(function* stopped() {
	const fs = yield* FileSystem.FileSystem;
	const of = yield* world;

	yield* broken(of, "hang");

	const canaryRan = fs
		.exists(`${of.fakeHarnessFolder}/canary-ran`)
		.pipe(Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: Boolean }));

	const run = setUp(of, "claude", maxAnswers);
	const ending = yield* Effect.raceFirst(Effect.as(run, "ended"), Effect.as(canaryRan, "killed"));

	yield* Effect.sleep("1 second");

	assert.strictEqual(ending, "killed", "setup was killed while its test ran");
	yield* untouched(of);
}).pipe(Effect.scoped);

it.layer(layer)("setup refused", (test) => {
	test.effect.each(badKeys)("a bad key changes nothing: $kind", badKey, patient);
	test.effect.each(endedAt)("input that ends at $kind saves and changes nothing", ended, patient);
	test.effect("a failed test installs nothing and leaves Claude Code's folder as it was", () => failedTest, patient);
	test.effect("an installer that exits 0 but installs nothing stops setup", () => hollowInstall, patient);
	test.effect.each(askedAgainFor)(
		"setup asks for a new BAA key at the hidden prompt and saves it over the old one when $kind",
		askedAgain,
		patient,
	);
});

it.layer(layer, { excludeTestServices: true })("setup stopped, on the real clock", (test) => {
	test.effect("a setup stopped during its test leaves Claude Code's settings byte for byte", () => stopped, patient);
});
