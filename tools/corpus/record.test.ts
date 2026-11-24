import { Array, DateTime, Effect, Option, pipe } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { dateIn2025, uuidWith } from "./record.ts";
import { seeded } from "./random.ts";

const seed = 1729;

const draws = 1000;

const versionFourWithVariantEight = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u;

const isCalendarDate = (date: string): boolean =>
	Option.exists(DateTime.make(`${date}T00:00:00Z`), (parsed) => DateTime.formatIsoDate(parsed) === date);

const calendarDates = Effect.sync(() => {
	const rng = seeded(seed);

	const invalid = pipe(
		Array.makeBy(draws, () => dateIn2025(rng)),
		Array.filter((date) => !isCalendarDate(date)),
	);

	assert.deepStrictEqual(invalid, []);
});

const versionFour = Effect.sync(() => {
	assert.match(uuidWith(() => "8")(seeded(seed)), versionFourWithVariantEight);
});

describe("record", () => {
	it.effect("every date dateIn2025 draws is a real calendar date", () => calendarDates);

	it.effect("uuidWith draws a version-4 UUID with the variant digit it is given", () => versionFour);
});
