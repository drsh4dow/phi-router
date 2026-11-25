import { Effect, Struct } from "effect";
import { assert, it } from "@effect/vitest";
import type { Found } from "./plan.ts";
import { plan } from "./plan.ts";
import { stops } from "./copy.ts";

const codex: Found = {
	kept: {},
	keys: [],
	mac: false,
	others: [],
	own: { account: "you@example.com", kind: "plan", plan: "plus" },
	signInHow: "codex login",
	title: "Codex",
	vendor: "openai",
};

it.effect("an answer of no OpenAI key stops setup even when setup found none to offer", () =>
	Effect.sync(() => {
		assert.deepStrictEqual(plan({ answers: { baa: "none" }, found: codex }), { kind: "stop", line: stops.noJudge });
	}),
);

const refusedJudge = Struct.assign(codex, {
	kept: { judge: { key: { keyFile: "/keys/openai" }, label: { plan: "OpenAI" }, rekey: true } },
	keys: [{ place: "pi", vendor: "openai" }],
} as const);

it.effect(
	"a refused PHI check key on Codex takes the OpenAI key picked for patient data, so one file holds one key",
	() =>
		Effect.sync(() => {
			const piKey = { kind: "key", place: "pi", vendor: "openai" };

			assert.deepNestedInclude(plan({ answers: { baa: "pi" }, found: refusedJudge }), {
				kind: "ready",
				"roles.baa": piKey,
				"roles.judge": piKey,
			});
		}),
);
