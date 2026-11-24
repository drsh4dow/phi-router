import { Array, Effect, Record, String as Str, pipe } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { synthetic, syntheticListed } from "./synthetic.ts";
import { seeded } from "./random.ts";

const firstSeed = 1;

const lastSeed = 10;

const seeds = Array.range(firstSeed, lastSeed);

const identityPatterns = [/NM1\*IL\*1\*(?<name>[^~]*?)\*{4}MI\*(?<member>[^*~]*)~/gu, /member=(?<member>\S+)/gu];

const identitiesIn = (payload: string): readonly string[] =>
	pipe(
		identityPatterns,
		Array.flatMap((pattern) => Array.fromIterable(Str.matchAll(pattern)(payload))),
		Array.flatMap(({ groups }) => Record.values(groups ?? {})),
	);

const listedIdentities = Effect.sync(() => {
	const identities = pipe(
		syntheticListed,
		Array.flatMap((draw) =>
			pipe(
				seeds,
				Array.flatMap((seed) => identitiesIn(draw(seeded(seed)).payload)),
			),
		),
	);

	const unlisted = pipe(
		identities,
		Array.filter((identity) => !Array.contains(synthetic.exact, identity)),
	);

	assert.isNotEmpty(identities);
	assert.deepStrictEqual(unlisted, []);
});

describe("synthetic identities", () => {
	it.effect(
		"the subscriber name and member id of a synthetic-listed 837 or staging log are on the exact list",
		() => listedIdentities,
	);
});
