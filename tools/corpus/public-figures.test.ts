import { Array, Effect, pipe } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { figures } from "./public-figures.ts";

const deathYearBound = 1950;

const longDead = Effect.sync(() => {
	const recent = pipe(
		figures,
		Array.filter(({ died }) => died >= deathYearBound),
		Array.map(({ name }) => name),
	);

	assert.deepStrictEqual(recent, []);
});

describe("public figures", () => {
	it.effect("every person on the public-figure list died before 1950", () => longDead);
});
