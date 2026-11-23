import { Array, Option, Predicate, pipe } from "effect";
import { Entry, TextCarriers, TextIdentifiers, Transform } from "./manifest.ts";
import type { PhiStrata, TextCarrier, TextIdentifier } from "./manifest.ts";
import type { Random } from "./random.ts";
import { identifierKind } from "#router/features/policy/index.ts";

interface TextStrata extends PhiStrata {
	readonly identifier: TextIdentifier;
	readonly carrier: TextCarrier;
}

type Rule = Partial<TextStrata>;

const perIdentifier = 22;

const buriedCount = 10;

const unrealisticCarriers: readonly Rule[] = [
	{ carrier: "clinical-note", transform: "buried" },
	{ carrier: "ticket", transform: "buried" },
];

/** A summary never stops in the middle of an identifier. */
const unrealisticSummaries: readonly Rule[] = [
	{ entry: "compaction-summary", transform: "buried" },
	{ entry: "compaction-summary", transform: "gzip-hex" },
	{ entry: "compaction-summary", transform: "split" },
];

/** A split cuts one identifier, and a companion identifier would stay whole beside it. */
const unrealisticSplits: readonly Rule[] = [
	{ identifier: identifierKind.birthDate, transform: "split" },
	{ carrier: "x12-837", transform: "split" },
];

/**
 * A BAA account's reply quotes the payload lines that hold the identifier, which an encoded or split payload has none
 * of.
 */
const unrealisticBaaReplies: readonly Rule[] = [
	{ entry: "ent-reply", transform: "split" },
	{ entry: "ent-reply", transform: "buried" },
	{ entry: "ent-reply", transform: "base64" },
	{ entry: "ent-reply", transform: "gzip-hex" },
];

const unrealistic = [...unrealisticCarriers, ...unrealisticSummaries, ...unrealisticSplits, ...unrealisticBaaReplies];

const axes = ["identifier", "carrier", "transform", "entry"] as const;

const isRealistic = (strata: Rule): boolean =>
	!pipe(
		unrealistic,
		Array.some((rule) =>
			pipe(
				axes,
				Array.every((axis) => Predicate.isUndefined(rule[axis]) || rule[axis] === strata[axis]),
			),
		),
	);

const deck = <Value>(rng: Random, values: readonly Value[], size: number): Value[] => {
	const cycled = Array.flatten(Array.replicate(values, Math.ceil(size / values.length)));

	return rng.shuffle(Array.take(cycled, size));
};

/**
 * Deals `size` values from a shuffled deck of `all`. Each deal takes the first card left that fits, or, when none
 * does, a fitting value drawn from all of them.
 *
 * @param {Random} rng The draw source.
 * @param {Array.NonEmptyReadonlyArray} all Every value.
 * @param {number} size How many cards the deck holds.
 * @returns {(fits: (value: Value) => boolean) => Value} Deals one value.
 */
const dealer = <Value>(
	rng: Random,
	all: Array.NonEmptyReadonlyArray<Value>,
	size: number,
): ((fits: (value: Value) => boolean) => Value) => {
	let left = deck(rng, all, size);

	return (fits) =>
		Option.match(
			Array.findFirstIndex(left, (value) => fits(value)),
			{
				onNone: () =>
					Option.getOrElse(
						Array.findFirst(rng.shuffle(all), (value) => fits(value)),
						() => Array.headNonEmpty(all),
					),
				onSome: (index) => {
					const card = Array.getUnsafe(left, index);

					left = Array.remove(left, index);

					return card;
				},
			},
		);
};

/**
 * Deals the PHI strata like a Latin square: every axis value appears about equally often, combinations spread
 * at random, and an unrealistic combination is re-drawn.
 *
 * @param {Random} rng The draw source.
 * @returns {readonly TextStrata[]} The strata, one per text case.
 */
const planStrata = (rng: Random): readonly TextStrata[] => {
	const total = TextIdentifiers.literals.length * perIdentifier;

	const unburied = pipe(
		Transform.literals,
		Array.filter((transform) => transform !== "buried"),
	);

	const identifiers = deck(rng, TextIdentifiers.literals, total);
	const transforms = [...Array.replicate("buried" as const, buriedCount), ...deck(rng, unburied, total - buriedCount)];
	const dealCarrier = dealer(rng, TextCarriers.literals, total);
	const dealEntry = dealer(rng, Entry.literals, total);

	const plans = Array.zipWith(identifiers, transforms, (identifier, transform) => {
		const carrier = dealCarrier((value) => isRealistic({ carrier: value, identifier, transform }));
		const entry = dealEntry((value) => isRealistic({ carrier, entry: value, identifier, transform }));

		return { carrier, entry, identifier, transform };
	});

	return rng.shuffle(plans);
};

export { planStrata };

export type { TextStrata };
