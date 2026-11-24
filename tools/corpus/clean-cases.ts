import { Array, pipe } from "effect";
import { Entry, Negative } from "./manifest.ts";
import type { Planted, Random } from "./random.ts";
import type { CleanCase } from "./manifest.ts";
import type { Sample } from "./conversation.ts";
import type { TextNegative } from "./negative-samplers.ts";
import { converse } from "./conversation.ts";
import { samplers } from "./negative-samplers.ts";

interface PlannedCleanCase {
	readonly negative: TextNegative;
	readonly indexInNegative: number;
}

const perNegative = 32;

const textNegatives: readonly TextNegative[] = pipe(
	Negative.literals,
	Array.filter((negative): negative is TextNegative => negative !== "clean-screenshot"),
);

const planNegatives = (): PlannedCleanCase[] =>
	pipe(
		textNegatives,
		Array.flatMap((negative) => Array.makeBy(perNegative, (indexInNegative) => ({ indexInNegative, negative }))),
	);

const nth = <Item>(items: Array.NonEmptyReadonlyArray<Item>, index: number): Item =>
	items[index % items.length] ?? Array.headNonEmpty(items);

const freshSample = (draw: () => Sample, used: Planted): Sample => {
	const sample = draw();
	const fragments = sample.fragments ?? [];

	const repeats = pipe(
		fragments,
		Array.some((fragment) => used.has(fragment)),
	);

	if (repeats) {
		return freshSample(draw, used);
	}

	for (const fragment of fragments) {
		used.add(fragment);
	}

	return sample;
};

interface CleanCaseRequest extends PlannedCleanCase {
	readonly rng: Random;
	readonly used: Planted;
}

const cleanCase = ({ negative, indexInNegative, rng, used }: CleanCaseRequest): Omit<typeof CleanCase.Type, "id"> => {
	const sample = freshSample(() => nth(samplers[negative], indexInNegative)(rng), used);

	const messages = converse({
		entry: nth(Entry.literals, indexInNegative),
		parts: [sample.payload],
		quotes: [],
		rng,
		scene: sample.scene,
	});

	return { canaries: [], expect: "clean", fragments: sample.fragments ?? [], messages, strata: { negative } };
};

export { cleanCase, planNegatives };
