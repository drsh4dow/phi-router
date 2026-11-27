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

const unrealisticSummaries: readonly Rule[] = [
	{ entry: "compaction-summary", transform: "buried" },
	{ entry: "compaction-summary", transform: "gzip-hex" },
	{ entry: "compaction-summary", transform: "split" },
];

const unrealisticSplits: readonly Rule[] = [
	{ identifier: identifierKind.birthDate, transform: "split" },
	{ carrier: "x12-837", transform: "split" },
];

const unrealisticFileNames: readonly Rule[] = [{ carrier: "file-name", identifier: identifierKind.personalUrl }];

const unrealisticBaaReplies: readonly Rule[] = [
	{ entry: "ent-reply", transform: "split" },
	{ entry: "ent-reply", transform: "buried" },
	{ entry: "ent-reply", transform: "base64" },
	{ entry: "ent-reply", transform: "gzip-hex" },
];

const unrealistic = [
	...unrealisticCarriers,
	...unrealisticSummaries,
	...unrealisticSplits,
	...unrealisticFileNames,
	...unrealisticBaaReplies,
];

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
