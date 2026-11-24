import { Effect, Struct } from "effect";
import { assert, it } from "@effect/vitest";
import { cleanReachOf, failed } from "./wire-table.ts";

const outcome = {
	baaRequests: 0,
	expect: "phi",
	fragments: [],
	id: "t-1",
	leaked: [],
	missing: [],
	openRequests: 0,
	split: [],
	unstubbed: [],
} as const;

const cleanReach = Effect.sync(() => {
	const report = cleanReachOf([
		Struct.assign(outcome, { expect: "clean", id: "c-1", openRequests: 2 } as const),
		Struct.assign(outcome, { expect: "clean", id: "c-2", openRequests: 0 } as const),
		Struct.assign(outcome, { expect: "phi", id: "p-1", openRequests: 3 } as const),
	]);

	assert.deepStrictEqual(report, {
		lines: ["c-1\topen", "c-2\tBAA only", "clean cases on an open account's mock: 1 of 2 (50%)"],
		reached: 1,
	});
});

const gate = Effect.sync(() => {
	assert.deepStrictEqual(
		[
			failed(outcome),
			failed(Struct.assign(outcome, { missing: ["MRN 4417-2290"] })),
			failed(Struct.assign(outcome, { brokenBecause: "pi exited before the second turn" })),
		],
		[false, true, true],
	);
});

it.effect(
	"a case whose PHI did not all reach the BAA account, or that the harness broke on, fails the gate",
	() => gate,
);

it.effect(
	"the clean report gives each clean case's lane and the share that reached an open account's mock",
	() => cleanReach,
);
