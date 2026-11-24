import { Array, Effect, String as Str, pipe } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { seeded } from "./random.ts";
import { staffContacts } from "./staff-contacts.ts";

const firstSeed = 1;

const lastSeed = 20;

const seeds = Array.range(firstSeed, lastSeed);

const phonesIn = (text: string): readonly string[] =>
	pipe(
		Array.fromIterable(Str.matchAll(/(?<!\d)\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}(?!\d)/gu)(text)),
		Array.map(([phone]) => Str.replaceAll(/\D/gu, "")(phone)),
	);

const fictionPhones = Effect.sync(() => {
	const phones = pipe(
		staffContacts,
		Array.flatMap((draw) =>
			pipe(
				seeds,
				Array.flatMap((seed) => phonesIn(draw(seeded(seed)).payload)),
			),
		),
	);

	const real = pipe(
		phones,
		Array.filter((phone) => !/^\d{3}55501\d{2}$/u.test(phone)),
	);

	assert.isNotEmpty(phones);
	assert.deepStrictEqual(real, []);
});

describe("staff contacts", () => {
	it.effect("every staff-contact phone is 555-0100 to 555-0199, the range reserved for fiction", () => fictionPhones);
});
