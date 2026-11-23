import { Effect, FileSystem, Formatter, String as Str } from "effect";
import type { Typed, TypedRan, World } from "./world.ts";
import { assert, it } from "@effect/vitest";
import { configOf, enter, keyFiles, layer, leaks, ok, patient, piAuthOf, setUp } from "./set-up.ts";
import { keys, world } from "./world.ts";
import type { PlatformError } from "effect";

const offer = "pi already has an Anthropic API key. Use it? Say yes only if it is from your BAA account. [y/N]";

const pasteQuestion = "Paste the Anthropic API key your organization gave you for patient data.";

const refusal =
	"Anthropic refused that key. Nothing was saved or changed. Check it with whoever gave it to you, then rerun the command.";

const subscriptionCopy = "That is a Claude subscription token, not an API key.";

/** What a screen splits into around a line it shows once: the text before it and the text after. */
const once = 2;

/**
 * An answer to the offer.
 *
 * @param {string} typed The answer.
 * @returns {Typed} The answer, typed once the offer shows.
 */
const answered = (typed: string): Typed => ({ after: "[y/N] ", typed });

/** A paste setup refuses at once, so a run that reaches the paste question ends there. */
const stopAtPaste: Typed = { after: "Key: ", typed: keys.subscription };

/** The Anthropic entry of pi's `auth.json`: an API key, or a subscription login. */
type PiLogin =
	| { readonly type: "api_key"; readonly key: string }
	| { readonly type: "oauth"; readonly access: string; readonly refresh: string; readonly expires: number };

/** The `auth.json` of pi with `anthropic` as its Anthropic entry. */
const piHolds = Effect.fnUntraced(function* piHolds(of: World, anthropic: PiLogin) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.writeFileString(piAuthOf(of), Formatter.formatJson({ anthropic }), { mode: 0o600 });
});

/**
 * An API-key entry of pi's `auth.json`.
 *
 * @param {string} key The key, or a `!` command that prints it.
 * @returns {PiLogin} The entry.
 */
const piApiKey = (key: string): PiLogin => ({ key, type: "api_key" });

/**
 * Checks that `shown` shows `first` once, and `second` after it and not before.
 *
 * @param {string} shown What the terminal showed.
 * @param {string} first The line shown first.
 * @param {string} second The line shown after it.
 */
const assertOnceBefore = (shown: string, first: string, second: string): void => {
	const parts = Str.split(first)(shown);
	const [before, after = ""] = parts;

	assert.strictEqual(parts.length, once, `${first} once:\n${shown}`);
	assert.notInclude(before, second, `${second} not before ${first}`);
	assert.include(after, second, `${second} after ${first}`);
};

/** Checks that no file of the world but a key file and pi's `auth.json`, and nothing `run` showed, holds a key. */
const assertNoLeak = Effect.fnUntraced(function* assertNoLeak(of: World, run: TypedRan) {
	const leaked = yield* leaks(of, [run.shown]);

	assert.deepStrictEqual(leaked, [], "no key outside its key file");
});

/** Checks the run that took pi's key: no Anthropic paste question, the key in its key file and `config.json`. */
const assertTaken = Effect.fnUntraced(function* assertTaken(of: World, run: TypedRan) {
	const fs = yield* FileSystem.FileSystem;
	const config = yield* configOf(of);
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

	yield* piHolds(of, piApiKey(keys.anthropic));

	const run = yield* setUp(of, "claude", [answered("y"), enter]);

	yield* assertTaken(of, run);
	yield* assertNoLeak(of, run);
}).pipe(Effect.scoped);

const pastedOnNo = Effect.gen(function* pastedOnNo() {
	const of = yield* world;

	yield* piHolds(of, piApiKey(keys.anthropic));

	const run = yield* setUp(of, "pi", [answered("n"), { after: "Key: ", typed: keys.anthropic }, enter]);

	const config = yield* configOf(of);

	assert.strictEqual(run.exitCode, ok, run.shown);
	assertOnceBefore(run.shown, offer, pasteQuestion);
	assert.include(run.shown, "pi started");
	assert.property(config, "sealed");

	yield* assertNoLeak(of, run);
}).pipe(Effect.scoped);

const pastedOnEnter = Effect.gen(function* pastedOnEnter() {
	const of = yield* world;

	yield* piHolds(of, piApiKey(keys.anthropic));

	const run = yield* setUp(of, "pi", [answered(""), stopAtPaste]);

	assertOnceBefore(run.shown, offer, pasteQuestion);
	assert.include(run.shown, subscriptionCopy);

	yield* assertNoLeak(of, run);
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

	yield* assertNoLeak(of, run);
}).pipe(Effect.scoped);

/** A pi that offers nothing, and what makes it so. */
interface Unoffered {
	readonly kind: string;
	readonly given: (of: World) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>;
}

const noPi = Effect.fnUntraced(function* noPi(of: World) {
	const fs = yield* FileSystem.FileSystem;

	yield* piHolds(of, piApiKey(keys.anthropic));
	yield* fs.remove(`${of.bin}/pi`);
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
	assert.include(run.shown, pasteQuestion);
	assert.include(run.shown, subscriptionCopy);
}, Effect.scoped);

it.layer(layer)("setup offers the Anthropic API key pi holds", (test) => {
	test.effect("setup claude takes pi's key on y, checks it and saves it in the key file", () => takenOnYes, patient);
	test.effect("setup pi asks for a paste on n", () => pastedOnNo, patient);
	test.effect("setup pi asks for a paste on Enter", () => pastedOnEnter, patient);
	test.effect("a key Anthropic refuses goes to the paste question with the refusal", () => refusedThenPasted, patient);
	test.effect.each(unoffered)("setup goes straight to the paste question when $kind", straightToPaste, patient);
});
