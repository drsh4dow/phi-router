import { Effect, FileSystem, Formatter, String as Str, Struct } from "effect";
import type { Typed, TypedRan, World } from "./world.ts";
import { assert, it } from "@effect/vitest";
import {
	enter,
	keyFiles,
	keysOutsideKeyFiles,
	layer,
	ok,
	patient,
	piAuthOf,
	setUp,
	writtenConfigOf,
} from "./set-up.ts";
import { keys, world } from "./world.ts";
import type { PlatformError } from "effect";

const offer = "pi already has an Anthropic API key. Use it? Say yes only if it is from your BAA account. [y/N]";

const pasteQuestion = "Paste the Anthropic API key your organization gave you for patient data.";

const refusal =
	"Anthropic refused that key. Nothing was saved or changed. Check it with whoever gave it to you, then rerun the command.";

const subscriptionCopy = "That is a Claude subscription token, not an API key.";

const partsAroundOneLine = 2;

const answered = (typed: string): Typed => ({ after: "[y/N] ", typed });

const stopAtPaste: Typed = { after: "Key: ", typed: keys.subscription };

type PiAnthropicEntry =
	| { readonly type: "api_key"; readonly key: string }
	| { readonly type: "oauth"; readonly access: string; readonly refresh: string; readonly expires: number };

const piHolds = Effect.fnUntraced(function* piHolds(of: World, anthropic: PiAnthropicEntry) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.writeFileString(piAuthOf(of), Formatter.formatJson({ anthropic }), { mode: 0o600 });
});

const piApiKey = (key: string): PiAnthropicEntry => ({ key, type: "api_key" });

const assertOnceBefore = (shown: string, first: string, second: string): void => {
	const parts = Str.split(first)(shown);
	const [before, after = ""] = parts;

	assert.strictEqual(parts.length, partsAroundOneLine, `${first} once:\n${shown}`);
	assert.notInclude(before, second, `${second} not before ${first}`);
	assert.include(after, second, `${second} after ${first}`);
};

const assertKeysInKeyFiles = Effect.fnUntraced(function* assertKeysInKeyFiles(of: World, run: TypedRan) {
	const outside = yield* keysOutsideKeyFiles(of, [run.shown]);

	assert.deepStrictEqual(outside, [], "no key outside its key file");
});

const assertTaken = Effect.fnUntraced(function* assertTaken(of: World, run: TypedRan) {
	const fs = yield* FileSystem.FileSystem;
	const config = yield* writtenConfigOf(of);
	const { anthropic } = keyFiles(of);
	const saved = yield* fs.readFileString(anthropic);

	assert.strictEqual(run.exitCode, ok, run.shown);
	assertOnceBefore(run.shown, offer, "✓ Anthropic accepted the key");
	assert.notInclude(run.shown, pasteQuestion, "no Anthropic paste question");
	assert.strictEqual(Str.trim(saved), keys.anthropic);
	assert.deepNestedInclude(config, { "sealed[0].keyFile": anthropic, "sealed[0].scheme": "apiKey" });
});

const takenOnYes = Effect.gen(function* takenOnYes() {
	const of = yield* world;

	yield* piHolds(of, piApiKey(`!printf %s ${keys.anthropic}`));

	const run = yield* setUp(of, "claude", [answered("y"), enter]);

	yield* assertTaken(of, run);
	yield* assertKeysInKeyFiles(of, run);
}).pipe(Effect.scoped);

const pastedOnNo = Effect.gen(function* pastedOnNo() {
	const of = yield* world;

	yield* piHolds(of, piApiKey(keys.anthropic));

	const run = yield* setUp(of, "pi", [answered("n"), { after: "Key: ", typed: keys.anthropic }, enter]);

	const config = yield* writtenConfigOf(of);

	assert.strictEqual(run.exitCode, ok, run.shown);
	assertOnceBefore(run.shown, offer, pasteQuestion);
	assert.include(run.shown, "pi started");
	assert.property(config, "sealed");

	yield* assertKeysInKeyFiles(of, run);
}).pipe(Effect.scoped);

const pastedOnEnter = Effect.gen(function* pastedOnEnter() {
	const of = yield* world;

	yield* piHolds(of, piApiKey(keys.anthropic));

	const run = yield* setUp(of, "pi", [answered(""), stopAtPaste]);

	assertOnceBefore(run.shown, offer, pasteQuestion);
	assert.include(run.shown, subscriptionCopy);

	yield* assertKeysInKeyFiles(of, run);
}).pipe(Effect.scoped);

const refusedThenPasted = Effect.gen(function* refusedThenPasted() {
	const fs = yield* FileSystem.FileSystem;
	const of = yield* world;

	yield* piHolds(of, piApiKey(keys.refused));

	const run = yield* setUp(of, "claude", [answered("y"), stopAtPaste]);
	const saved = yield* fs.exists(keyFiles(of).anthropic);

	assertOnceBefore(run.shown, offer, refusal);
	assertOnceBefore(run.shown, refusal, pasteQuestion);
	assert.include(run.shown, subscriptionCopy);
	assert.isFalse(saved, "no key saved");

	yield* assertKeysInKeyFiles(of, run);
}).pipe(Effect.scoped);

interface Unoffered {
	readonly kind: string;
	readonly given: (of: World) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>;
}

const noPi = Effect.fnUntraced(function* noPi(of: World) {
	const fs = yield* FileSystem.FileSystem;

	yield* piHolds(of, piApiKey(keys.anthropic));
	yield* fs.remove(`${of.fakeHarnessFolder}/pi`);
});

const unoffered: readonly Unoffered[] = [
	{
		given: (of) =>
			piHolds(of, {
				access: keys.subscription,
				expires: 9_999_999_999_999,
				refresh: "phi-test-refresh",
				type: "oauth",
			}),
		kind: "pi holds only a subscription login",
	},
	{ given: (of) => piHolds(of, piApiKey(keys.subscription)), kind: "pi holds a subscription token as its API key" },
	{ given: noPi, kind: "no pi is on PATH" },
	{ given: (of) => piHolds(of, piApiKey("!exit 3")), kind: "pi auth print-api-key exits non-zero" },
];

const straightToPaste = Effect.fnUntraced(function* straightToPaste({ given }: Unoffered) {
	const of = yield* world;

	yield* given(of);

	const run = yield* setUp(of, "claude", [stopAtPaste]);

	assert.notInclude(run.shown, "pi already has", run.shown);
	assert.notInclude(run.shown, "Error: ", "nothing pi printed reaches the terminal");
	assert.include(run.shown, pasteQuestion);
	assert.include(run.shown, subscriptionCopy);
}, Effect.scoped);

const shellKeyUnoffered = Effect.gen(function* shellKeyUnoffered() {
	const fs = yield* FileSystem.FileSystem;
	const of = yield* world;
	const shell = Struct.assign(of.env, { ANTHROPIC_API_KEY: keys.anthropic });
	const openAiOnly = Formatter.formatJson({ openai: { key: keys.openai, type: "api_key" } });

	yield* fs.writeFileString(piAuthOf(of), openAiOnly, { mode: 0o600 });

	const run = yield* setUp(Struct.assign(of, { env: shell }), "claude", [stopAtPaste]);

	assert.notInclude(run.shown, "pi already has", run.shown);
	assert.include(run.shown, pasteQuestion);
}).pipe(Effect.scoped);

it.layer(layer)("setup offers the Anthropic API key pi holds", (test) => {
	test.effect(
		"setup claude takes on y the key a `!` command in pi's auth.json prints, checks it and saves it in the key file",
		() => takenOnYes,
		patient,
	);
	test.effect("setup pi asks for a paste on n", () => pastedOnNo, patient);
	test.effect("setup pi asks for a paste on Enter", () => pastedOnEnter, patient);
	test.effect("a key Anthropic refuses goes to the paste question with the refusal", () => refusedThenPasted, patient);
	test.effect.each(unoffered)("setup goes straight to the paste question when $kind", straightToPaste, patient);
	test.effect(
		"setup goes straight to the paste question when only the developer's shell holds an Anthropic API key",
		() => shellKeyUnoffered,
		patient,
	);
});
