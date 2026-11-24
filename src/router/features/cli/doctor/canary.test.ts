import { Array, Effect, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { canaryChecks } from "./canary.ts";

const canary = "phi-doctor-canary-42";

const body = (text: string): string => `{"model":"phi/auto","messages":[{"role":"user","content":"${text}"}]}`;

const cases = [
	{ arrived: { baa: [body(canary)], open: [body("ok")] }, passed: true, what: "the BAA mock alone" },
	{ arrived: { baa: [body(canary)], open: [body(canary)] }, passed: false, what: "the BAA and an open mock" },
	{ arrived: { baa: [], open: [body(canary)] }, passed: false, what: "an open mock alone" },
	{ arrived: { baa: [body("ok")], open: [body("ok")] }, passed: false, what: "neither mock" },
	{
		arrived: { baa: [body(canary)], open: [body("phi-doctor-"), body("canary-42")] },
		passed: true,
		what: "the BAA mock whole, and two open bodies in halves",
	},
];

it.effect.each(cases)("the canary checks pass when the canary arrived at $what: $passed", ({ arrived, passed }) =>
	Effect.sync(() => {
		const checks = canaryChecks({ arrived, canary });

		assert.strictEqual(
			pipe(
				checks,
				Array.every((check) => check.passed),
			),
			passed,
		);
	}),
);
