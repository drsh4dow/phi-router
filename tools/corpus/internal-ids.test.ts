import { Array, Effect, pipe } from "effect";
import { assert, describe, it } from "@effect/vitest";
import type { Scene } from "./conversation.ts";
import { TextCarriers } from "./manifest.ts";
import { carriers } from "./carriers.ts";
import { internalIdHealth } from "./internal-ids.ts";
import { seeded } from "./random.ts";

const everyCarrierButThe837 = Effect.sync(() => {
	const scenes: readonly Scene[] = pipe(
		internalIdHealth,
		Array.map((draw, seed) => draw(seeded(seed)).scene),
	);

	const expected: readonly Scene[] = pipe(
		TextCarriers.literals,
		Array.filter((carrier) => carrier !== "x12-837"),
		Array.map((carrier) => carriers[carrier]),
	);

	assert.deepStrictEqual(scenes, expected);
});

describe("internal ids", () => {
	it.effect(
		"an internal-id-health case comes in every text carrier but the 837, which needs a name and member id",
		() => everyCarrierButThe837,
	);
});
