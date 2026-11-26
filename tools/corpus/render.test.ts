import { Array, Effect, String as Str, pipe } from "effect";
import { assert, describe, it } from "@effect/vitest";
import type { Report } from "./report.ts";
import { outputOf } from "./render.ts";

const report: Report = {
	fragments: { cases: 0, shown: 0 },
	judge: { calls: 0, cost: 0, failures: 0, inputTokens: 0, ms: 0 },
	leaks: [],
	overRouting: [],
	requests: { clean: 0, sealing: 0 },
	splits: [],
	strata: [
		{ axis: "transform", cases: 42, leakRateUpper95: 0.0688, leaks: 0, value: "base64" },
		{ axis: "carrier", cases: 7, leakRateUpper95: 0.3481, leaks: 1, value: "csv" },
	],
};

const titleLines = 1;

const strataTableLines = 3;

const aligned = Effect.sync(() => {
	const strataTable = pipe(Str.split("\n")(outputOf(report)), Array.drop(titleLines), Array.take(strataTableLines));

	assert.deepStrictEqual(strataTable, [
		"axis       value    N  leaks  upper95",
		"transform  base64  42      0   0.0688",
		"carrier    csv      7      1   0.3481",
	]);
});

describe("render", () => {
	it.effect("a report table pads its label columns on the right and its number columns on the left", () => aligned);
});
