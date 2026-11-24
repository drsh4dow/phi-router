import { Array, Effect, Equivalence, String as Str, pipe } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { seeded } from "./random.ts";
import { withTypos } from "./transforms.ts";

const seeds = 200;

const longWord = 5;

const sentence = "The claim for Mr Tan was sent to the payer twice, and the clearinghouse rejected both of them.";

const canary = "Coria Brannridge";

const note = `Referral for ${canary}: the cardiology consult says ${canary} needs a follow-up visit.`;

const sameTexts = Array.makeEquivalence(Equivalence.String);

const typed = (text: string, canaries: readonly string[]): string[] =>
	Array.makeBy(seeds, (seed) => withTypos({ canaries, rng: seeded(seed) })(text));

const wordsOf = (text: string): string[] =>
	pipe(
		Array.fromIterable(Str.matchAll(/\p{L}+/gu)(text)),
		Array.map(([word]) => word),
	);

const betweenWords = Str.split(/\p{L}+/u);

const typedOnlyLongWords = (output: string): boolean => {
	const pairs = Array.zip(wordsOf(sentence), wordsOf(output));

	return (
		sameTexts(betweenWords(output), betweenWords(sentence)) &&
		wordsOf(output).length === wordsOf(sentence).length &&
		pipe(
			pairs,
			Array.every(([was, now]) => was.length >= longWord || was === now),
		)
	);
};

const longWordsOnly = Effect.sync(() => {
	const outputs = typed(sentence, []);

	assert.deepStrictEqual(
		pipe(
			outputs,
			Array.filter((output) => !typedOnlyLongWords(output)),
		),
		[],
	);
	assert.isTrue(
		pipe(
			outputs,
			Array.some((output) => output !== sentence),
		),
	);
});

const canariesKept = Effect.sync(() => {
	const outputs = typed(note, [canary]);

	assert.deepStrictEqual(
		pipe(
			outputs,
			Array.filter((output) => Str.split(canary)(output).length !== Str.split(canary)(note).length),
		),
		[],
	);
});

describe("transforms", () => {
	it.effect(
		"withTypos misspells only words of five letters or more, and keeps every other word and character",
		() => longWordsOnly,
	);
	it.effect("withTypos keeps every canary whole", () => canariesKept);
});
