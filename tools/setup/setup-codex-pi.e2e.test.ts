import { Array, Effect, FileSystem, Formatter, Path, String as Str, pipe } from "effect";
import type { TypedRan, World } from "./world.ts";
import {
	argsOf,
	callsOf,
	configOf,
	enter,
	keyFiles,
	keysOutsideKeyFiles,
	layer,
	ok,
	patient,
	setUp,
	version,
} from "./set-up.ts";
import { assert, it } from "@effect/vitest";
import { keys, world } from "./world.ts";

const codexEnd = `Press Enter to start Codex. It asks once to review phi-router's hooks.
Pick "Trust all and continue". Until you do, prompts fail and nothing is sent.`;

const piEnd =
	"Press Enter to start pi on phi/auto. Only phi/auto is protected. Other models in /model skip phi-router.";

/** What a screen splits into around one `Key: ` question: the text before it and the text after. */
const oneQuestion = 2;

const assertCodexScreens = (run: TypedRan): void => {
	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.strictEqual(Str.split("Key: ")(run.shown).length, oneQuestion, "one key question");
	assert.include(run.shown, "It starts with sk-. Nothing shows while you paste. Then press Enter.");
	assert.include(run.shown, "✓ OpenAI accepted the key");
	assert.include(run.shown, "✓ Codex now sends its requests through phi-router");
	assert.include(run.shown, codexEnd);
	assert.include(run.shown, "codex started");
};

const configuredCodex = Effect.fnUntraced(function* configuredCodex(of: World) {
	const config = yield* configOf(of);
	const { openai } = keyFiles(of);

	assert.deepStrictEqual(config, {
		clean: [{ forwarded: true, name: "codex-1", vendor: "openai" }],
		sealed: [{ keyFile: openai, name: "openai-1", scheme: "apiKey", vendor: "openai" }],
	});

	const codexArgs = yield* argsOf(of, "codex");
	const calls = yield* callsOf(of, "codex");
	const installs = pipe(codexArgs, Array.filter(Str.startsWith("plugin ")));

	assert.deepStrictEqual(installs, [
		`plugin marketplace add drsh4dow/phi-router --ref v${version}`,
		"plugin add phi-router@phi-router",
	]);
	assert.deepStrictEqual(calls, ["test", "install", "start"], "the test runs before anything is installed");
});

const codexSetUp = Effect.gen(function* codexSetUp() {
	const of = yield* world;
	const run = yield* setUp(of, "codex", [{ after: "Key: ", typed: keys.openai }, enter]);

	assertCodexScreens(run);
	yield* configuredCodex(of);

	const outside = yield* keysOutsideKeyFiles(of, [run.shown]);

	assert.deepStrictEqual(outside, [], "no key outside its key file");
}).pipe(Effect.scoped);

const keyed = Effect.fnUntraced(function* keyed(of: World) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const { anthropic } = keyFiles(of);
	const config = { clean: [], judge: { endpoint: "http://127.0.0.1:9/v1", keyEnv: "UNSET" }, sealed: [] };

	yield* fs.makeDirectory(path.dirname(anthropic), { recursive: true });
	yield* fs.writeFileString(anthropic, `${keys.anthropic}\n`);
	yield* fs.writeFileString(`${of.xdg.XDG_CONFIG_HOME}/phi-router/config.json`, Formatter.formatJson(config));
});

const assertPiScreens = (run: TypedRan): void => {
	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.notInclude(run.shown, "Key:", "no question");
	assert.include(run.shown, "Your BAA account           already set up");
	assert.include(run.shown, "✓ Installed phi-router in pi");
	assert.include(run.shown, piEnd);
	assert.include(run.shown, "pi started");
};

const piSetUp = Effect.gen(function* piSetUp() {
	const of = yield* world;

	yield* keyed(of);

	const run = yield* setUp(of, "pi", [enter]);

	assertPiScreens(run);

	const piArgs = yield* argsOf(of, "pi");
	const calls = yield* callsOf(of, "pi");

	assert.include(piArgs, `install npm:phi-router@${version}`);
	assert.deepStrictEqual(calls, ["test", "install", "start"], "the test runs before anything is installed");
}).pipe(Effect.scoped);

it.layer(layer)("setup codex and setup pi", (test) => {
	test.effect(
		"setup codex asks one OpenAI key, installs with codex, and ends with Codex's lines",
		() => codexSetUp,
		patient,
	);

	test.effect(
		"setup pi asks nothing once phi-router holds an Anthropic key, installs with pi install, and starts pi on phi/auto",
		() => piSetUp,
		patient,
	);
});
