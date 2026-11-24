import { Array, Effect, pipe } from "effect";
import type { TextCarrier, TextIdentifier } from "./manifest.ts";
import { TextCarriers, TextIdentifiers } from "./manifest.ts";
import { assert, describe, it } from "@effect/vitest";
import { drawRecord } from "./phi-records.ts";
import { identifierKind } from "#router/features/policy/index.ts";
import { seeded } from "./random.ts";

const kindsOf = (identifier: TextIdentifier, carrier: TextCarrier): readonly TextIdentifier[] =>
	pipe(
		drawRecord({
			rng: seeded(identifier.length + carrier.length),
			strata: { carrier, entry: "user", identifier, transform: "plain" },
			used: new Set(),
		}).fields,
		Array.map(({ kind }) => kind),
	);

const everyStratum = pipe(
	TextIdentifiers.literals,
	Array.flatMap((identifier) =>
		pipe(
			TextCarriers.literals,
			Array.map((carrier) => ({ carrier, identifier })),
		),
	),
);

const holdsItsIdentifier = Effect.sync(() => {
	const missing = pipe(
		everyStratum,
		Array.filter(({ identifier, carrier }) => !Array.contains(kindsOf(identifier, carrier), identifier)),
	);

	assert.deepStrictEqual(missing, []);
});

const birthDateWithName = Effect.sync(() => {
	const nameless = pipe(
		TextCarriers.literals,
		Array.filter(
			(carrier) => !Array.contains(kindsOf(identifierKind.birthDate, carrier), identifierKind.patientName),
		),
	);

	assert.deepStrictEqual(nameless, []);
});

describe("phi records", () => {
	it.effect(
		"a PHI case's record holds a value of its stratum's identifier, in every carrier",
		() => holdsItsIdentifier,
	);
	it.effect("a birth-date case's record also holds its owner's name, in every carrier", () => birthDateWithName);
});
