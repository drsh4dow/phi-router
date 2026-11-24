import { Array, Effect, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { canaryChecks, turnCheck } from "./canary.ts";
import type { Turn } from "#router/client/harnesses/index.ts";

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

const turns: readonly { readonly turn: Turn; readonly passed: boolean }[] = [
	{ passed: true, turn: { exitCode: 0, kind: "exited", printed: "ok" } },
	{ passed: false, turn: { exitCode: 1, kind: "exited", printed: "refused" } },
	{ passed: false, turn: { kind: "notStarted" } },
	{ passed: false, turn: { kind: "timedOut" } },
];

it.effect.each(turns)("the turn check passes only when the headless command exited 0: $turn", ({ passed, turn }) =>
	Effect.sync(() => {
		assert.strictEqual(turnCheck({ binary: "claude", headless: "claude -p" })(turn).passed, passed);
	}),
);
