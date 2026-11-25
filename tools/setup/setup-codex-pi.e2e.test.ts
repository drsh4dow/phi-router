import { Array, Effect, String as Str, pipe } from "effect";
import type { TypedRan, World } from "./world.ts";
import {
	argsOf,
	callsOf,
	codexSignedIn,
	down,
	enter,
	keyFiles,
	keysOutsideKeyFiles,
	lastLine,
	layer,
	maxAnswers,
	ok,
	patient,
	piHolds,
	piLogin,
	setUp,
	tracked,
	version,
	withEnv,
	writtenConfigOf,
} from "./set-up.ts";
import { assert, it } from "@effect/vitest";
import { keys, world } from "./world.ts";

const codexFound = `phi-router found
  Codex           ChatGPT Plus · you@example.com
  Claude Code     Claude Max · you@example.com

  Everyday work   ChatGPT Plus · you@example.com   ✓
  Patient data    needs an OpenAI key
  PHI check       same key
`;

const codexEnd = `✓ OpenAI key works
✓ Installed phi-router in Codex
✓ Test: a fake patient record went to your BAA account, not ChatGPT Plus
✓ Codex now sends its requests through phi-router

  Everyday work   ChatGPT Plus · you@example.com
  Patient data    OpenAI API key
  PHI check       OpenAI

Done. Close any Codex window that was already open, and use the one setup starts.
Undo any time with: npx phi-router off codex

Press Enter to start Codex. It asks once to review phi-router's hooks.
Pick "Trust all and continue". Until you do, prompts fail and nothing is sent.`;

const piEnd = `✓ Installed phi-router in pi
✓ Test: a fake patient record went to your BAA account, not Claude

  Everyday work   Claude
  Patient data    Anthropic API key
  PHI check       OpenAI

Done. Close any pi window that was already open, and use the one setup starts.
Undo any time with: pi remove npm:phi-router@${version}

Press Enter to start pi on phi/auto. Only phi/auto is protected. Other models in /model skip phi-router.`;

const partsAroundOneKey = 2;

const assertCodexScreens = (run: TypedRan): void => {
	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.include(run.shown, codexFound);
	assert.strictEqual(Str.split("OpenAI key (BAA): ")(run.shown).length, partsAroundOneKey, "one key question");
	assert.notInclude(run.shown, "OpenAI key (PHI check)", "the PHI check takes the same key");
	assert.include(run.shown, codexEnd);
	assert.include(run.shown, "codex started");
};

const configuredCodex = Effect.fnUntraced(function* configuredCodex(of: World) {
	const config = yield* writtenConfigOf(of);
	const { openai } = keyFiles(of);

	assert.deepStrictEqual(config, {
		clean: [{ forwarded: true, name: "codex-1", vendor: "openai" }],
		judge: { endpoint: "https://api.openai.com/v1", keyFile: openai },
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

	yield* codexSignedIn(of);

	const run = yield* setUp(of, "codex", [{ after: "OpenAI key (BAA)", typed: keys.openai }, enter]);
	const checked = yield* of.checkedKeys();

	assertCodexScreens(run);
	assert.deepStrictEqual(checked, [keys.openai], "setup checked the one key once");
	yield* configuredCodex(of);

	const outside = yield* keysOutsideKeyFiles(of, [run.shown]);

	assert.deepStrictEqual(outside, [], "no key outside its key file");
}).pipe(Effect.scoped);

const foundKeyPicked = Effect.gen(function* foundKeyPicked() {
	const made = yield* world;
	const of = withEnv({ OPENAI_API_KEY: keys.openai })(made);

	yield* codexSignedIn(of);

	const run = yield* setUp(of, "codex", [{ after: "Which OpenAI key does your BAA cover?", typed: down }, enter]);
	const config = yield* writtenConfigOf(of);
	const judge = { endpoint: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" };

	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.strictEqual(
		Str.split("Which OpenAI key does your BAA cover? ")(run.shown).length,
		partsAroundOneKey,
		"one pick for the BAA account and the PHI check",
	);
	assert.deepNestedInclude(config, { judge, "sealed[0].keyEnv": "OPENAI_API_KEY" });
}).pipe(Effect.scoped);

const piSetUp = Effect.gen(function* piSetUp() {
	const of = yield* world;

	yield* piHolds(of, { anthropic: piLogin });

	const run = yield* setUp(of, "pi", maxAnswers);
	const config = yield* writtenConfigOf(of);
	const { anthropic, openai } = keyFiles(of);

	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.include(
		run.shown,
		"phi-router found\n  pi              Claude\n  Claude Code     Claude Max · you@example.com\n",
	);
	assert.include(run.shown, piEnd);
	assert.include(run.shown, "pi started");
	assert.deepStrictEqual(config, {
		clean: [{ forwarded: true, name: "claude-1", vendor: "anthropic" }],
		judge: { endpoint: "https://api.openai.com/v1", keyFile: openai },
		sealed: [{ keyFile: anthropic, name: "claude-2", scheme: "apiKey", vendor: "anthropic" }],
	});

	const piArgs = yield* argsOf(of, "pi");
	const calls = yield* callsOf(of, "pi");

	assert.include(piArgs, `install npm:phi-router@${version}`);
	assert.deepStrictEqual(calls, ["test", "install", "start"], "the test runs before anything is installed");
}).pipe(Effect.scoped);

interface SignedOut {
	readonly harness: "codex" | "pi";
	readonly line: string;
}

const signedOut: readonly SignedOut[] = [
	{ harness: "codex", line: "Sign in to Codex first with codex login. Nothing changed." },
	{ harness: "pi", line: "Sign in to pi first with /login. Nothing changed." },
];

const stoppedSignedOut = Effect.fnUntraced(function* stoppedSignedOut({ harness, line }: SignedOut) {
	const of = yield* world;
	const { after, before, run } = yield* tracked(of, ["setup", harness], []);

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.strictEqual(lastLine(run.shown), line);
	assert.deepStrictEqual(after, before, "nothing changed");
}, Effect.scoped);

it.layer(layer)("setup codex and setup pi", (test) => {
	test.effect(
		"setup codex asks one OpenAI key for the BAA account and the PHI check, installs with codex, and ends with Codex's lines",
		() => codexSetUp,
		patient,
	);
	test.effect(
		"setup codex asks once which OpenAI key the BAA covers when it finds one, for the BAA account and the PHI check",
		() => foundKeyPicked,
		patient,
	);
	test.effect(
		"setup pi on pi's Claude login takes both keys, installs with pi install, and starts pi on phi/auto",
		() => piSetUp,
		patient,
	);
	test.effect.each(signedOut)(
		"setup $harness stops before any change when $harness is not signed in",
		stoppedSignedOut,
		patient,
	);
});
