import { Effect, FileSystem, Schedule } from "effect";
import { argsOf, callsOf, keyAnswers, layer, ok, ownSettings, owned, patient, setUp, settled } from "./set-up.ts";
import { assert, it } from "@effect/vitest";
import { keys, snapshot, world } from "./world.ts";
import type { World } from "./world.ts";
import { phiRouter } from "#tools/cli/accounts-run.ts";

/** A key setup refuses, and what it says to it. */
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

	yield* settled(of);

	const before = yield* owned(of);
	const run = yield* setUp(of, "claude", [{ after: "Key: ", typed: pasted }]);
	const after = yield* owned(of);

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.include(run.shown, copy);
	assert.deepStrictEqual(after, before, "no key file, no config.json and no harness setting");

	const claudeArgs = yield* argsOf(of, "claude");

	assert.deepStrictEqual(claudeArgs, [], "nothing installed");
}, Effect.scoped);

const noTerminal = Effect.gen(function* noTerminal() {
	const of = yield* world;
	const before = yield* owned(of);
	const run = yield* phiRouter(of.env, ["setup", "claude"]);
	const after = yield* owned(of);

	assert.notStrictEqual(run.exitCode, ok);
	assert.include(
		run.stderr,
		"phi-router setup asks for a key, so it needs your own terminal. Run it yourself, outside your coding agent. Nothing was changed.",
	);
	assert.deepStrictEqual(after, before);
}).pipe(Effect.scoped);

/** Claude Code's own settings, with every fake harness's canary turn set to `hang` or to `fail`. */
const broken = Effect.fnUntraced(function* broken(of: World, how: "hang" | "fail") {
	const fs = yield* FileSystem.FileSystem;

	yield* settled(of);
	yield* fs.writeFileString(`${of.bin}/${how}`, "");
});

/** Checks setup ran the fake harness's test and nothing after it, and left Claude Code's settings byte for byte. */
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

	const before = yield* snapshot(of.folders.CLAUDE_CONFIG_DIR);
	const run = yield* setUp(of, "claude", keyAnswers);
	const after = yield* snapshot(of.folders.CLAUDE_CONFIG_DIR);

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.include(
		run.shown,
		"The test failed, so Claude Code was left as it was. Your key is saved. For details, run: npx phi-router doctor claude",
	);
	assert.deepStrictEqual(after, before, "Claude Code's folder as it was");
	yield* untouched(of);
}).pipe(Effect.scoped);

const stopped = Effect.gen(function* stopped() {
	const fs = yield* FileSystem.FileSystem;
	const of = yield* world;

	yield* broken(of, "hang");

	const canaryRan = fs
		.exists(`${of.bin}/canary-ran`)
		.pipe(Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: Boolean }));

	const run = setUp(of, "claude", keyAnswers);
	const ended = yield* Effect.raceFirst(Effect.as(run, "ended"), Effect.as(canaryRan, "killed"));

	yield* Effect.sleep("1 second");

	assert.strictEqual(ended, "killed", "setup was killed while its test ran");
	yield* untouched(of);
}).pipe(Effect.scoped);

it.layer(layer)("setup refused", (test) => {
	test.effect.each(badKeys)("a bad key changes nothing: $kind", badKey, patient);
	test.effect("setup with no terminal says so and changes nothing", () => noTerminal, patient);
	test.effect("a failed test installs nothing and leaves Claude Code's folder as it was", () => failedTest, patient);
});

it.layer(layer, { excludeTestServices: true })("setup stopped, on the real clock", (test) => {
	test.effect("a setup stopped during its test leaves Claude Code's settings byte for byte", () => stopped, patient);
});
