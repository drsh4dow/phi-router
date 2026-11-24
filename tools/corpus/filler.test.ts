import { Array, Effect, Number as Num, Option, String as Str, pipe } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { bury } from "./filler.ts";
import { seeded } from "./random.ts";

const seeds = 100;

const fillerSeeds = 20;

const size = 10_000;

const payload = "PID|1||E4417229||Brannridge^Coria";

const burial = { firstShare: 0.35, lastShare: 0.64, lineShare: 0.01 } as const;

const carrierLines = {
	csv: /^2025-\d\d-\d\d,(?:us-west|us-east|eu-central),SKU-\d{5},\d+,\d+\.\d\d,(?:web|partner|retail)$/u,
	"sql-dump": /^INSERT INTO public\.\w+ VALUES \(.+\);$/u,
} as const;

const buried = (seed: number, carrier: keyof typeof carrierLines): string =>
	bury({ carrier, rng: seeded(seed), size })(payload);

const shareBefore = (seed: number): number => {
	const at = Option.getOrElse(Str.indexOf(`\n${payload}\n`)(buried(seed, "csv")), () => size);

	return Num.increment(at) / size;
};

const placement = Effect.sync(() => {
	const shares = Array.makeBy(seeds, shareBefore);
	const [first, last] = [Math.min(...shares), Math.max(...shares)];

	assert.isAtLeast(first, burial.firstShare);
	assert.isBelow(first, burial.firstShare + burial.lineShare);
	assert.isAtLeast(last, burial.lastShare);
	assert.isBelow(last, burial.lastShare + burial.lineShare);
});

const strayLines = (carrier: keyof typeof carrierLines): string[] =>
	pipe(
		Array.makeBy(fillerSeeds, (seed) => buried(seed, carrier)),
		Array.flatMap(Str.split("\n")),
		Array.filter((line) => line !== payload && !carrierLines[carrier].test(line)),
	);

const fillerLines = Effect.sync(() => {
	assert.deepStrictEqual([...strayLines("csv"), ...strayLines("sql-dump")], []);
});

describe("filler", () => {
	it.effect("bury puts the payload after 35% to 64% of its filler", () => placement);
	it.effect("bury fills around the payload with lines of its carrier", () => fillerLines);
});
