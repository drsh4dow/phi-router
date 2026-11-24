import { Array, Effect, pipe } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { cleanCase } from "./clean-cases.ts";
import { seeded } from "./random.ts";

const seed = 1;

const freshFragments = Effect.sync(() => {
	const used = new Set<string>();
	const first = cleanCase({ indexInNegative: 0, negative: "fragment", rng: seeded(seed), used });
	const again = cleanCase({ indexInNegative: 0, negative: "fragment", rng: seeded(seed), used });

	assert.isNotEmpty(first.fragments);
	assert.isNotEmpty(again.fragments);
	assert.deepStrictEqual(
		pipe(
			again.fragments,
			Array.filter((fragment) => Array.contains(first.fragments, fragment)),
		),
		[],
	);
	assert.deepStrictEqual(Array.fromIterable(used), [...first.fragments, ...again.fragments]);
});

describe("clean cases", () => {
	it.effect(
		"a clean case redraws until it plants no fragment already planted, and records the ones it plants",
		() => freshFragments,
	);
});
