import { Array, Effect } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { seeded, unique } from "./random.ts";

const seed = 7;

const draws = 2000;

const bound = 3;

const range = { high: 5, low: 2 } as const;

const valuesDrawn = (draw: () => number): ReadonlySet<number> => new Set(Array.makeBy(draws, draw));

const bounds = Effect.sync(() => {
	const rng = seeded(seed);

	assert.deepStrictEqual(
		valuesDrawn(() => rng.int(bound)),
		new Set(Array.makeBy(bound, (value) => value)),
	);
	assert.deepStrictEqual(
		valuesDrawn(() => rng.between(range.low, range.high)),
		new Set(Array.range(range.low, range.high)),
	);
});

const redraws = Effect.sync(() => {
	const planted = new Set(["MRN 4417-2290"]);
	const drawn = ["MRN 4417-2290", "MRN 4417-2290", "MRN 5528-3301"][Symbol.iterator]();

	const value = unique({ draw: () => drawn.next().value ?? "", used: planted });

	assert.strictEqual(value, "MRN 5528-3301");
	assert.deepStrictEqual([...planted], ["MRN 4417-2290", "MRN 5528-3301"]);
});

describe("random", () => {
	it.effect(
		"int draws every integer from 0 below its bound, and between every integer from low to high inclusive",
		() => bounds,
	);
	it.effect("unique draws again until the value is not planted yet, then plants it", () => redraws);
});
