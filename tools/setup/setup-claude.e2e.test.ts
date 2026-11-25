import { Array, Effect, FileSystem, Option, Path, String as Str } from "effect";
import type { TypedRan, World } from "./world.ts";
import {
	argsOf,
	baaKey,
	callsOf,
	endOfInput,
	firstPick,
	judgeKey,
	keyFiles,
	keyPicked,
	keysOutsideKeyFiles,
	lastLine,
	layer,
	maxAnswers,
	ok,
	patient,
	permissionBitsOf,
	questions,
	setUp,
	tracked,
	version,
	writeOwnSettings,
	writtenConfigOf,
} from "./set-up.ts";
import { assert, it } from "@effect/vitest";
import { keys, world } from "./world.ts";
import { packageOf, versionOf } from "#router/client/own-package.ts";

const foundScreen = `phi-router found
  Claude Code     Claude Max · you@example.com

  Everyday work   Claude Max · you@example.com   ✓
  Patient data    needs a BAA account
  PHI check       needs an OpenAI key
`;

const lastQuestion = "Press Enter to start Claude Code with phi-router.";

const lastScreen = `✓ Anthropic key works
✓ OpenAI key works
✓ Installed phi-router ${version} in Claude Code
✓ Test: a fake patient record went to your BAA account, not Claude Max
✓ Claude Code now sends its requests through phi-router

  Everyday work   Claude Max · you@example.com
  Patient data    Anthropic API key
  PHI check       OpenAI

Done. Claude Code windows that were already open, including the one you
started from, stop answering. Close them.
Undo any time with: npx phi-router off claude

${lastQuestion}`;

const keptScreen = `  Everyday work   Claude Max · you@example.com   ✓
  Patient data    Anthropic API key   ✓
  PHI check       OpenAI   ✓`;

const privateFile = 0o600;

const privateFolder = 0o700;

const installedOnce = 1;

const assertMaxScreens = (run: TypedRan): void => {
	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.include(run.shown, foundScreen);
	assert.deepStrictEqual(firstPick({ question: questions.baa, shown: run.shown }), [
		"❯ Anthropic API key",
		"  Claude Enterprise login",
	]);
	assert.include(run.shown, lastScreen);
	assert.include(run.shown, "claude started");
	assert.notInclude(run.shown, "phi-test", "no key shows as it is typed");
};

const configuredClaude = Effect.fnUntraced(function* configuredClaude(of: World) {
	const config = yield* writtenConfigOf(of);
	const { anthropic, openai } = keyFiles(of);

	assert.deepStrictEqual(config, {
		clean: [{ forwarded: true, name: "claude-1", vendor: "anthropic" }],
		judge: { endpoint: "https://api.openai.com/v1", keyFile: openai },
		sealed: [{ keyFile: anthropic, name: "claude-2", scheme: "apiKey", vendor: "anthropic" }],
	});

	const claudeArgs = yield* argsOf(of, "claude");
	const calls = yield* callsOf(of, "claude");

	assert.include(claudeArgs, "plugin install phi-router --marketplace drsh4dow/phi-router@release --scope user");
	assert.deepStrictEqual(calls, ["test", "install", "start"], "the test runs before anything is installed");
});

const switchedClaude = Effect.fnUntraced(function* switchedClaude(of: World) {
	const fs = yield* FileSystem.FileSystem;
	const settings = yield* fs.readFileString(`${of.folders.CLAUDE_CONFIG_DIR}/settings.json`);

	assert.include(settings, '"ANTHROPIC_BASE_URL": "http://127.0.0.1:47411"');
	assert.include(settings, '"autoUpdate": true', "Claude Code updates the release channel by itself");
	assert.include(settings, '"model": "opus"');
});

const savedKeys = Effect.fnUntraced(function* savedKeys(of: World) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const { anthropic, openai } = keyFiles(of);
	const saved = yield* Effect.forEach([anthropic, openai], (file) => fs.readFileString(file), { concurrency: 1 });

	assert.deepStrictEqual(saved, [`${keys.anthropic}\n`, `${keys.openai}\n`]);

	const keyFolder = path.dirname(anthropic);
	const checked = [anthropic, openai, keyFolder, path.dirname(keyFolder)];
	const modes = yield* Effect.forEach(checked, permissionBitsOf, { concurrency: 1 });

	assert.deepStrictEqual(modes, [privateFile, privateFile, privateFolder, privateFolder]);
});

const rerunClaude = Effect.fnUntraced(function* rerunClaude(of: World) {
	const { after, before, run } = yield* tracked(of, ["setup", "claude"], [{ after: lastQuestion, typed: "" }]);

	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.notInclude(run.shown, "❯", "a rerun with every role filled asks no question");
	assert.notInclude(run.shown, "key (", "a rerun asks for no key");
	assert.include(run.shown, keptScreen);
	assert.deepStrictEqual(after, before, "a rerun changes no file");

	const pluginRuns = yield* Effect.map(argsOf(of, "claude"), Array.filter(Str.startsWith("plugin ")));

	assert.strictEqual(pluginRuns.length, installedOnce, "a rerun installs nothing");

	return run;
});

const maxSetUp = Effect.gen(function* maxSetUp() {
	const of = yield* world;

	yield* writeOwnSettings(of);

	const run = yield* setUp(of, "claude", maxAnswers);
	const checked = yield* of.checkedKeys();

	assert.deepStrictEqual(checked, [keys.anthropic, keys.openai], "setup asked each vendor about its pasted key");
	assertMaxScreens(run);
	yield* configuredClaude(of);
	yield* switchedClaude(of);
	yield* savedKeys(of);

	const again = yield* rerunClaude(of);
	const outside = yield* keysOutsideKeyFiles(of, [run.shown, again.shown]);

	assert.deepStrictEqual(outside, [], "no key outside its key file");
}).pipe(Effect.scoped);

const echoedThenEnded = Effect.gen(function* echoedThenEnded() {
	const of = yield* world;

	yield* writeOwnSettings(of);

	const run = yield* setUp(of, "claude", [keyPicked, baaKey, judgeKey, { after: lastQuestion, typed: "go" }]);

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

const noJudge =
	"The PHI check needs an OpenAI key covered by your BAA. Run setup again when you have one. Nothing changed.";

const emptyOpenAiKey = Effect.gen(function* emptyOpenAiKey() {
	const of = yield* world;

	yield* writeOwnSettings(of);

	const { after, before, run } = yield* tracked(
		of,
		["setup", "claude"],
		[keyPicked, baaKey, { after: "OpenAI key (PHI check)", typed: "" }],
	);

	const checked = yield* of.checkedKeys();

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.strictEqual(lastLine(run.shown), noJudge);
	assert.deepStrictEqual(checked, [], "no key was checked");
	assert.deepStrictEqual(after, before, "no key file, no config.json and no harness setting");
}).pipe(Effect.scoped);

it.layer(layer)("setup claude", (test) => {
	test.effect(
		"setup claude on a Max login offers an API key or an Enterprise login, takes both keys at hidden prompts, tests before it installs, switches on last and names the three roles, and a second run asks nothing and changes nothing",
		() => maxSetUp,
		patient,
	);
	test.effect(
		"setup claude gives the terminal its echo back after the hidden keys, and starts nothing when the input ends at its last question",
		() => echoedThenEnded,
		patient,
	);
	test.effect(
		"setup claude stops and changes nothing when Enter leaves the OpenAI key empty",
		() => emptyOpenAiKey,
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
