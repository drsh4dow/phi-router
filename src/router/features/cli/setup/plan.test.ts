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

const refusedJudgeWithEnvKey = Struct.assign(refusedJudge, { keys: [{ place: "env", vendor: "openai" }] } as const);

it.effect(
	"a refused PHI check key on Codex is asked again when patient data takes OPENAI_API_KEY, which no key file holds",
	() =>
		Effect.sync(() => {
			assert.deepNestedInclude(plan({ answers: { baa: "env" }, found: refusedJudgeWithEnvKey }), {
				kind: "ready",
				"roles.baa": { kind: "key", place: "env", vendor: "openai" },
				"roles.judge": { kind: "key", place: "typed", vendor: "openai" },
			});
		}),
);
