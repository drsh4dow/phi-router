import { Effect, FileSystem, String as Str } from "effect";
import { assert, it } from "@effect/vitest";
import {
	down,
	endOfInput,
	enter,
	firstPick,
	judgeKey,
	keyFiles,
	keysOutsideKeyFiles,
	lastLine,
	layer,
	noAnother,
	ok,
	patient,
	piHolds,
	piLogin,
	questions,
	setUp,
	writtenConfigOf,
} from "./set-up.ts";
import { filesUnder, keys, world } from "./world.ts";
import type { PiEntry } from "./set-up.ts";
import type { PlatformError } from "effect";
import type { World } from "./world.ts";

const piChoice = { after: questions.baa, typed: `${down}${down}` };

const anthropicPick = ["❯ Anthropic API key", "  Claude Enterprise login"];

const piApiKey = (key: string): PiEntry => ({ key, type: "api_key" });

const piKeyOnly = (of: World, key: string): ReturnType<typeof piHolds> => piHolds(of, { anthropic: piApiKey(key) });

const taken = Effect.gen(function* taken() {
	const fs = yield* FileSystem.FileSystem;
	const of = yield* world;

	yield* piKeyOnly(of, `!printf %s ${keys.anthropic}`);

	const run = yield* setUp(of, "claude", [piChoice, noAnother, judgeKey, enter]);
	const config = yield* writtenConfigOf(of);
	const { anthropic } = keyFiles(of);
	const saved = yield* fs.readFileString(anthropic);
	const checked = yield* of.checkedKeys();
	const outside = yield* keysOutsideKeyFiles(of, [run.shown]);

	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.deepStrictEqual(firstPick({ question: questions.baa, shown: run.shown }), [
		...anthropicPick,
		"  Anthropic key saved in pi",
	]);
	assert.include(run.shown, "  Patient data    Anthropic key saved in pi\n");
	assert.deepStrictEqual(checked, [keys.anthropic, keys.openai]);
	assert.strictEqual(Str.trim(saved), keys.anthropic);
	assert.deepNestedInclude(config, { "sealed[0].keyFile": anthropic, "sealed[0].scheme": "apiKey" });
	assert.deepStrictEqual(outside, [], "no key outside its key file");
}).pipe(Effect.scoped);

const refusal =
	"Anthropic refused that key. Nothing was saved or changed. Check it with whoever gave it to you, then rerun the command.";

const refused = Effect.gen(function* refused() {
	const of = yield* world;

	yield* piKeyOnly(of, keys.refused);

	const before = yield* filesUnder(of.xdg.XDG_CONFIG_HOME);
	const run = yield* setUp(of, "claude", [piChoice, noAnother, judgeKey]);
	const after = yield* filesUnder(of.xdg.XDG_CONFIG_HOME);
	const outside = yield* keysOutsideKeyFiles(of, [run.shown]);

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.strictEqual(lastLine(run.shown), refusal);
	assert.deepStrictEqual(after, before, "no key file and no config.json");
	assert.deepStrictEqual(outside, [], "no key outside its key file");
}).pipe(Effect.scoped);

interface Unoffered {
	readonly kind: string;
	readonly given: (of: World) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>;
}

const noPi = Effect.fnUntraced(function* noPi(of: World) {
	const fs = yield* FileSystem.FileSystem;

	yield* piKeyOnly(of, keys.anthropic);
	yield* fs.remove(`${of.fakeHarnessFolder}/pi`);
});

const unoffered: readonly Unoffered[] = [
	{ given: (of) => piHolds(of, { anthropic: piLogin }), kind: "pi holds only a subscription login" },
	{ given: (of) => piKeyOnly(of, keys.subscription), kind: "pi holds a subscription token as its API key" },
	{ given: noPi, kind: "no pi is on PATH" },
	{ given: (of) => piKeyOnly(of, "!exit 3"), kind: "pi auth print-api-key exits non-zero" },
];

const notOffered = Effect.fnUntraced(function* notOffered({ given }: Unoffered) {
	const of = yield* world;

	yield* given(of);

	const run = yield* setUp(of, "claude", [{ after: questions.baa, typed: endOfInput }]);

	assert.deepStrictEqual(firstPick({ question: questions.baa, shown: run.shown }), anthropicPick, run.shown);
	assert.notInclude(run.shown, "saved in pi");
	assert.notInclude(run.shown, "Error: ", "nothing pi printed reaches the terminal");
}, Effect.scoped);

it.layer(layer)("setup offers the Anthropic API key pi holds", (test) => {
	test.effect(
		"setup claude offers the key a `!` command in pi's auth.json prints, and on that pick checks it and saves it in the key file",
		() => taken,
		patient,
	);
	test.effect("a key pi holds that Anthropic refuses stops setup and saves nothing", () => refused, patient);
	test.effect.each(unoffered)("setup offers no pi key when $kind", notOffered, patient);
});
