import { Effect, Struct } from "effect";
import type { Found, Step } from "./plan.ts";
import { assert, it } from "@effect/vitest";
import { keyPrompt, plan } from "./plan.ts";
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

			assert.deepNestedInclude(plan({ answers: { another: "no", baa: "pi" }, found: refusedJudge }), {
				kind: "ready",
				"roles.baa": piKey,
				"roles.judge": piKey,
			});
		}),
);

it.effect(
	"a first setup asks, once the accounts are settled, whether to add another subscription, naming the open account",
	() =>
		Effect.sync(() => {
			assert.deepStrictEqual(plan({ answers: {}, found: codex }), {
				kind: "ask",
				question: {
					choices: [
						{ id: "yes", label: "Yes" },
						{ id: "no", label: "No" },
					],
					id: "another",
					text: "Add another subscription? It takes over when plus · you@example.com hits its rate limit.",
				},
			});
			assert.deepNestedInclude(plan({ answers: { another: "yes" }, found: codex }), {
				another: true,
				kind: "ready",
			});
		}),
);

const held = { key: { keyFile: "/keys/openai" }, label: { plan: "OpenAI" }, rekey: false };

const setUp = Struct.assign(codex, {
	kept: { baa: held, judge: held, open: { label: { plan: "plus" }, rekey: false } },
});

it.effect("a setup that keeps the accounts it holds never offers another subscription, whatever was answered", () =>
	Effect.sync(() => {
		assert.deepNestedInclude(plan({ answers: {}, found: setUp }), { another: false, kind: "ready" });
		assert.deepNestedInclude(plan({ answers: { another: "yes" }, found: setUp }), { another: false, kind: "ready" });
	}),
);

const enterpriseClaude: Found = {
	kept: {},
	keys: [{ place: "env", vendor: "openai" }],
	mac: false,
	others: [],
	own: { account: "doctor@example.com", kind: "enterprise" },
	signInHow: "claude auth login",
	title: "Claude Code",
	vendor: "anthropic",
};

const signedInEveryday = { enterprise: "yes", everyday: "subscription", judge: "env" } as const;

it.effect(
	"a first setup on Claude Enterprise asks, after the everyday sign-in is chosen, whether to add another subscription, and a yes adds one",
	() =>
		Effect.sync(() => {
			assert.deepNestedInclude(plan({ answers: signedInEveryday, found: enterpriseClaude }), {
				kind: "ask",
				"question.id": "another",
				"question.text":
					"Add another subscription? It takes over when the subscription you sign in to hits its rate limit.",
			});
			assert.deepNestedInclude(
				plan({ answers: Struct.assign({ another: "yes" } as const, signedInEveryday), found: enterpriseClaude }),
				{ another: true, kind: "ready", "roles.open": { kind: "signIn", role: "open" } },
			);
		}),
);

const refusedJudgeWithEnvKey = Struct.assign(refusedJudge, { keys: [{ place: "env", vendor: "openai" }] } as const);

const openaiPrompts = (step: Step): readonly string[] => {
	if (step.kind !== "ready") {
		return [];
	}

	return [keyPrompt({ roles: step.roles, vendor: "openai" })];
};

it.effect(
	"a refused PHI check key on Codex is asked again when patient data takes OPENAI_API_KEY, which no key file holds",
	() =>
		Effect.sync(() => {
			const step = plan({ answers: { another: "no", baa: "env" }, found: refusedJudgeWithEnvKey });

			assert.deepNestedInclude(step, {
				kind: "ready",
				"roles.baa": { kind: "key", place: "env", vendor: "openai" },
				"roles.judge": { kind: "key", place: "typed", vendor: "openai" },
			});
			assert.deepStrictEqual(openaiPrompts(step), ["OpenAI key (PHI check):"]);
		}),
);
