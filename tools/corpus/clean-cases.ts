import { Array, pipe } from "effect";
import { Entry, Negative } from "./manifest.ts";
import type { CleanCase } from "./manifest.ts";
import type { Random } from "./random.ts";
import type { Sample } from "./conversation.ts";
import type { TextNegative } from "./negative-samplers.ts";
import { converse } from "./conversation.ts";
import { samplers } from "./negative-samplers.ts";

/** The fragments planted so far in the file. */
interface PlantedFragments {
	readonly has: (fragment: string) => boolean;
	readonly add: (fragment: string) => void;
}

/** One clean case to generate: its negative stratum and its turn within that stratum. */
interface PlannedNegative {
	readonly negative: TextNegative;
	readonly turn: number;
}

const perNegative = 32;

const textNegatives: readonly TextNegative[] = pipe(
	Negative.literals,
	Array.filter((negative): negative is TextNegative => negative !== "clean-screenshot"),
);

const planNegatives = (): PlannedNegative[] =>
	pipe(
		textNegatives,
		Array.flatMap((negative) => Array.makeBy(perNegative, (turn) => ({ negative, turn }))),
	);

const nth = <Item>(items: Array.NonEmptyReadonlyArray<Item>, index: number): Item =>
	items[index % items.length] ?? Array.headNonEmpty(items);

/**
 * Draws until no fragment repeats one already planted, then records them, so fragments are unique across the file.
 *
 * @param {() => Sample} draw Draws one sample.
 * @param {PlantedFragments} used The fragments planted so far.
 * @returns {Sample} A sample whose fragments are all new.
 */
const freshSample = (draw: () => Sample, used: PlantedFragments): Sample => {
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

interface CleanCaseRequest extends PlannedNegative {
	readonly rng: Random;
	readonly used: PlantedFragments;
}

const cleanCase = ({ negative, turn, rng, used }: CleanCaseRequest): Omit<typeof CleanCase.Type, "id"> => {
	const sample = freshSample(() => nth(samplers[negative], turn)(rng), used);

	const messages = converse({
		entry: nth(Entry.literals, turn),
		parts: [sample.payload],
		quotes: [],
		rng,
		scene: sample.scene,
	});

	return { canaries: [], expect: "clean", fragments: sample.fragments ?? [], messages, strata: { negative } };
};

export { cleanCase, planNegatives };
