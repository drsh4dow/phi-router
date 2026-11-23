import { Array, Effect, FileSystem, Path, String as Str } from "effect";
import type { TypedRan, World } from "./world.ts";
import {
	argsOf,
	callsOf,
	claudeAnswers,
	configOf,
	enter,
	keyFiles,
	layer,
	leaks,
	modeOf,
	ok,
	owned,
	patient,
	setUp,
	settled,
} from "./set-up.ts";
import { assert, it } from "@effect/vitest";
import { keys, world } from "./world.ts";

const step3 = `phi-router keeps patient data off your Claude subscription.

  Your Claude subscription   already set up
  Your BAA account           needs an API key

Paste the Anthropic API key your organization gave you for patient data.
It starts with sk-ant-api. Nothing shows while you paste. Then press Enter.
The key is saved only on this computer, in a file only you can read.
Key: `;

const judgeQuestion = `Paste the OpenAI API key your organization gave you for the patient-data check.
Nothing shows while you paste. Then press Enter.
Key: `;

const step4 = `✓ Anthropic accepted the key
✓ Installed phi-router in Claude Code
✓ Test passed: a fake patient record went to your BAA account, not your subscription
✓ Claude Code now sends its requests through phi-router

Done. Claude Code windows that were already open, including the one you
started from, stop answering. Close them.
Undo any time with: npx phi-router off claude

Press Enter to start Claude Code with phi-router.`;

const privateFile = 0o600;

const privateFolder = 0o700;

const installedOnce = 1;

/**
 * Checks the screens a first `setup claude` showed.
 *
 * @param {TypedRan} run The run.
 */
const assertClaudeScreens = (run: TypedRan): void => {
	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.include(run.shown, step3, "the spec's step 3 screen");
	assert.include(run.shown, judgeQuestion, "the second hidden question, for the judge's key");
	assert.include(run.shown, step4, "the spec's step 4 screen");
	assert.include(run.shown, "claude started");
	assert.notInclude(run.shown, "phi-test", "no key shows as it is typed");
};

/** Checks the config.json setup wrote, and that it ran the test, then the spec's install, then claude. */
const configuredClaude = Effect.fnUntraced(function* configuredClaude(of: World) {
	const config = yield* configOf(of);

	assert.deepStrictEqual(config, {
		clean: [{ forwarded: true, name: "claude-1", vendor: "anthropic" }],
		judge: { endpoint: "https://api.openai.com/v1", keyFile: keyFiles(of).openai },
		sealed: [{ keyFile: keyFiles(of).anthropic, name: "claude-2", scheme: "apiKey", vendor: "anthropic" }],
	});

	const claudeArgs = yield* argsOf(of, "claude");
	const calls = yield* callsOf(of, "claude");

	assert.include(claudeArgs, `plugin install phi-router --marketplace ${of.copies.plugin} --scope user`);
	assert.deepStrictEqual(calls, ["test", "install", "start"], "the test runs before anything is installed");
});

/** Checks Claude Code's settings send it to the router and keep its own model. */
const switchedClaude = Effect.fnUntraced(function* switchedClaude(of: World) {
	const fs = yield* FileSystem.FileSystem;
	const settings = yield* fs.readFileString(`${of.folders.CLAUDE_CONFIG_DIR}/settings.json`);

	assert.include(settings, '"ANTHROPIC_BASE_URL": "http://127.0.0.1:47411"');
	assert.include(settings, '"model": "opus"');
});

/** Checks the saved keys, each in a file and folder only its owner can read. */
const savedKeys = Effect.fnUntraced(function* savedKeys(of: World) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const { anthropic, openai } = keyFiles(of);
	const anthropicKey = yield* fs.readFileString(anthropic);

	assert.strictEqual(anthropicKey, `${keys.anthropic}\n`);

	const keyFolder = path.dirname(anthropic);
	const checked = [anthropic, openai, keyFolder, path.dirname(keyFolder)];
	const modes = yield* Effect.forEach(checked, modeOf, { concurrency: 1 });

	assert.deepStrictEqual(modes, [privateFile, privateFile, privateFolder, privateFolder]);
});

/** Reruns `setup claude` and checks it asks nothing, changes nothing and installs nothing. */
const rerunClaude = Effect.fnUntraced(function* rerunClaude(of: World) {
	const before = yield* owned(of);
	const again = yield* setUp(of, "claude", [enter]);
	const after = yield* owned(of);

	assert.strictEqual(again.exitCode, ok, again.shown);
	assert.notInclude(again.shown, "Key:", "a rerun with a saved key that still works asks nothing");
	assert.include(again.shown, "Your BAA account           already set up");
	assert.deepStrictEqual(after, before, "a rerun changes no file");

	const pluginRuns = yield* Effect.map(argsOf(of, "claude"), Array.filter(Str.startsWith("plugin ")));

	assert.strictEqual(pluginRuns.length, installedOnce, "a rerun installs nothing");

	return again;
});

const claudeSetUp = Effect.gen(function* claudeSetUp() {
	const of = yield* world;

	yield* settled(of);

	const run = yield* setUp(of, "claude", claudeAnswers);

	assertClaudeScreens(run);
	yield* configuredClaude(of);
	yield* switchedClaude(of);
	yield* savedKeys(of);

	const again = yield* rerunClaude(of);
	const leaked = yield* leaks(of, [run.shown, again.shown]);

	assert.deepStrictEqual(leaked, [], "no key outside its key file");
}).pipe(Effect.scoped);

it.layer(layer)("setup claude", (test) => {
	test.effect(
		"setup claude asks both keys at hidden prompts, configures, installs, tests, switches on last and starts claude",
		() => claudeSetUp,
		patient,
	);
});
