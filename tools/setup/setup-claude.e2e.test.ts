import { Array, Effect, FileSystem, Formatter, Option, Path, String as Str, Struct } from "effect";
import type { TypedRan, World } from "./world.ts";
import {
	argsOf,
	callsOf,
	claudeAnswers,
	configOf,
	enter,
	keyAnswer,
	keyFiles,
	layer,
	leaks,
	modeOf,
	ok,
	owned,
	patient,
	setUp,
	settled,
	version,
} from "./set-up.ts";
import { assert, it } from "@effect/vitest";
import { keys, world } from "./world.ts";
import { packageOf, versionOf } from "#router/client/own-package.ts";
import type { Schema } from "effect";

const step3 = `phi-router keeps patient data off your Claude subscription.

  Your Claude subscription   already set up
  Your BAA account           needs an API key

Paste the Anthropic API key your organization gave you for patient data.
It starts with sk-ant-api. Nothing shows while you paste. Then press Enter.
The key is saved only on this computer, in a file only you can read.
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

/** What a screen splits into around one `Key: ` question: the text before it and the text after. */
const oneQuestion = 2;

/**
 * Checks the screens a first `setup claude` showed.
 *
 * @param {TypedRan} run The run.
 */
const assertClaudeScreens = (run: TypedRan): void => {
	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.include(run.shown, step3, "the spec's step 3 screen");
	assert.strictEqual(Str.split("Key: ")(run.shown).length, oneQuestion, "one key question");
	assert.notInclude(run.shown, "OpenAI", "no question for an OpenAI key");
	assert.include(run.shown, step4, "the spec's step 4 screen");
	assert.include(run.shown, "claude started");
	assert.notInclude(run.shown, "phi-test", "no key shows as it is typed");
};

/** A `config.json`'s two lanes. */
type ConfigFile = Readonly<Record<"clean" | "sealed", readonly Schema.Json[]>>;

/**
 * The `config.json` a first `setup claude` writes.
 *
 * @param {World} of The world.
 * @returns {object} The file's content.
 */
const claudeConfig = (of: World): ConfigFile => ({
	clean: [{ forwarded: true, name: "claude-1", vendor: "anthropic" }],
	sealed: [{ keyFile: keyFiles(of).anthropic, name: "claude-2", scheme: "apiKey", vendor: "anthropic" }],
});

/** Checks the config.json setup wrote, and that it ran the test, then the spec's install, then claude. */
const configuredClaude = Effect.fnUntraced(function* configuredClaude(of: World) {
	const config = yield* configOf(of);

	assert.deepStrictEqual(config, claudeConfig(of), "no judge block: the judge runs on the BAA key");

	const claudeArgs = yield* argsOf(of, "claude");
	const calls = yield* callsOf(of, "claude");

	assert.include(claudeArgs, `plugin install phi-router --marketplace drsh4dow/phi-router@v${version} --scope user`);
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
	const { anthropic } = keyFiles(of);
	const anthropicKey = yield* fs.readFileString(anthropic);

	assert.strictEqual(anthropicKey, `${keys.anthropic}\n`);

	const keyFolder = path.dirname(anthropic);
	const checked = [anthropic, keyFolder, path.dirname(keyFolder)];
	const modes = yield* Effect.forEach(checked, modeOf, { concurrency: 1 });

	assert.deepStrictEqual(modes, [privateFile, privateFolder, privateFolder]);
});

/** Adds the `judge` block an earlier setup wrote, which named the judge's own OpenAI key. */
const judged = Effect.fnUntraced(function* judged(of: World) {
	const fs = yield* FileSystem.FileSystem;
	const judge = { endpoint: "https://api.openai.com/v1", keyFile: keyFiles(of).openai };
	const config = Struct.assign(claudeConfig(of), { judge });

	yield* fs.writeFileString(`${of.xdg.XDG_CONFIG_HOME}/phi-router/config.json`, Formatter.formatJson(config));
});

/**
 * Gives `config.json` the `judge` block an earlier setup wrote, reruns `setup claude`, and checks it asks nothing,
 * changes nothing and installs nothing.
 */
const rerunClaude = Effect.fnUntraced(function* rerunClaude(of: World) {
	const before = yield* Effect.andThen(judged(of), owned(of));
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
	const checked = yield* of.checkedKeys();

	assert.deepStrictEqual(checked, [keys.anthropic], "setup asked the vendor about the pasted key alone");
	assertClaudeScreens(run);
	yield* configuredClaude(of);
	yield* switchedClaude(of);
	yield* savedKeys(of);

	const again = yield* rerunClaude(of);
	const leaked = yield* leaks(of, [run.shown, again.shown]);

	assert.deepStrictEqual(leaked, [], "no key outside its key file");
}).pipe(Effect.scoped);

const endOfInput = "\u0004";

const lastQuestion = "Press Enter to start Claude Code with phi-router.";

const echoedThenEnded = Effect.gen(function* echoedThenEnded() {
	const of = yield* world;

	yield* settled(of);

	const run = yield* setUp(of, "claude", [keyAnswer, { after: lastQuestion, typed: "go" }]);

	yield* setUp(of, "claude", [{ after: lastQuestion, typed: endOfInput }]);

	const calls = yield* callsOf(of, "claude");

	assert.deepStrictEqual(
		{
			echoed: Str.includes(`${lastQuestion}\ngo\n`)(run.shown),
			starts: Array.countBy(calls, (call) => call === "start"),
		},
		{ echoed: true, starts: 1 },
	);
}).pipe(Effect.scoped);

it.layer(layer)("setup claude", (test) => {
	test.effect(
		"setup claude asks one key at a hidden prompt, configures, installs, tests, switches on last and starts claude",
		() => claudeSetUp,
		patient,
	);
	test.effect(
		"setup claude gives the terminal its echo back after the hidden key, and starts nothing when the input ends at its last question",
		() => echoedThenEnded,
		patient,
	);
});

const bundled = ["plugins", "claude", "phi-router.mjs"] as const;

const ownPackages = Effect.gen(function* ownPackages() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-package-" });
	const installed = path.join(root, "node_modules", "phi-router");
	const other = path.join(root, "node_modules", "other");
	const nowhere = path.join(path.dirname(root), "nowhere.js");

	const made = Effect.fnUntraced(function* made(folder: string, release: string) {
		yield* fs.makeDirectory(path.join(folder, "plugins", "claude"), { recursive: true });
		yield* fs.writeFileString(path.join(folder, ...bundled), "");
		yield* fs.writeFileString(path.join(folder, "package.json"), `{"version":"${release}"}`);
	});

	yield* made(root, "1.0.0");
	yield* made(installed, "2.0.0");
	yield* fs.makeDirectory(other, { recursive: true });
	yield* fs.writeFileString(path.join(other, "package.json"), '{"version":"3.0.0"}');

	const found = yield* Effect.all(
		{
			installed: packageOf(path.join(installed, ...bundled)),
			nowhere: packageOf(nowhere),
			other: packageOf(path.join(other, "index.js")),
			version: versionOf(path.join(installed, ...bundled)),
		},
		{ concurrency: 1 },
	);

	assert.deepStrictEqual(found, {
		installed: Option.some(installed),
		nowhere: Option.none(),
		other: Option.some(root),
		version: "2.0.0",
	});
}).pipe(Effect.scoped);

it.layer(layer)("the phi-router package a file belongs to", (test) => {
	test.effect(
		"is the nearest folder above it that holds the plugin's bundle, and none when no folder does",
		() => ownPackages,
	);
});
