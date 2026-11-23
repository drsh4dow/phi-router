import { Effect, Struct } from "effect";
import { assert, it } from "@effect/vitest";
import { cleanReachOf } from "./wire-table.ts";

const outcome = {
	baa: 0,
	expect: "phi",
	fragments: [],
	id: "t-1",
	leaked: [],
	missing: [],
	open: 0,
	split: [],
	unsealed: [],
} as const;

const cleanReach = Effect.sync(() => {
	const report = cleanReachOf([
		Struct.assign(outcome, { expect: "clean", id: "c-1", open: 2 } as const),
		Struct.assign(outcome, { expect: "clean", id: "c-2", open: 0 } as const),
		Struct.assign(outcome, { expect: "phi", id: "p-1", open: 3 } as const),
	]);

	assert.deepStrictEqual(report, {
		lines: ["c-1\topen", "c-2\tBAA only", "clean cases on an open account's mock: 1 of 2 (50%)"],
		reached: 1,
	});
});

it.effect(
	"the clean report gives each clean case's lane and the share that reached an open account's mock",
	() => cleanReach,
);
