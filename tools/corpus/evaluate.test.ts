import { Array, Effect, Layer, Option, String as Str, pipe } from "effect";
import type { Case, Synthetic } from "./manifest.ts";
import { Rules, firstHit, identifierKind, stubs } from "#router/features/policy/index.ts";
import { assert, it } from "@effect/vitest";
import { evaluate, play } from "./evaluate.ts";
import { Digest } from "effect/crypto";
import { Judge } from "#router/client/judge.ts";
import { JudgeFailed } from "#router/client/judge-failed.ts";
import { missRateUpperBound } from "./report.ts";

/** Half a unit in the fourth decimal place, the tolerance of a bound given to four decimals. */
const fourDecimals = 0.00005;

const certain = 1;

const bounds = [
	{ cases: 20, misses: 0, upper: 0.1391 },
	{ cases: 100, misses: 0, upper: 0.0295 },
	{ cases: 20, misses: 1, upper: 0.2161 },
];

const usage = { calls: 1, cost: 0.001, inputTokens: 10, ms: 0 };

const sealingScore = 0.9;

const clearingScore = 0;

const noSynthetic = { exact: [], prefixes: [] };

const scoreOf = (piece: string): number => {
	if (Str.includes("SEAL")(piece)) {
		return sealingScore;
	}

	return clearingScore;
};

const judge = Judge.of({
	identifier: ({ piece }) => Effect.succeed({ score: scoreOf(piece), usage }),
	kind: (_input, question) =>
		pipe(
			question.criteria,
			Array.findFirst(([choice]) => choice === identifierKind.socialSecurityNumber),
			Option.match({
				onNone: () => Effect.fail(JudgeFailed.make({ why: "judge-error" })),
				onSome: ([choice]) => Effect.succeed({ kind: choice, usage }),
			}),
		),
});

const strata = {
	carrier: "log-line",
	entry: "tool-result",
	identifier: identifierKind.socialSecurityNumber,
	transform: "plain",
} as const;

const readRecord = (id: string, record: string): Case => ({
	canaries: [`canary-${id}`],
	expect: "phi",
	fragments: [],
	id,
	messages: [
		{ role: "user", text: "Why does the import drop this row?" },
		{ role: "assistant", text: "Reading the log." },
		{ role: "tool", text: `${record} canary-${id}` },
		{ role: "assistant", text: "The row has no member id." },
		{ role: "user", text: "Now add a test for it." },
	],
	strata,
});

const sealed = readRecord("sealed", "SEAL row 88");

const missed = readRecord("missed", "row 88");

const cleanCase = (
	negative: Extract<Case, { readonly expect: "clean" }>["strata"]["negative"],
	fragments: readonly string[],
	messages: Case["messages"],
): Case => ({ canaries: [], expect: "clean", fragments, id: "clean", messages, strata: { negative } });

const clean = cleanCase(
	"schema-only",
	[],
	[
		{ role: "user", text: "Add a nullable dob column to patients." },
		{ role: "assistant", text: "Done." },
		{ role: "user", text: "Now index it." },
	],
);

const splitMessages = (id: string, second: string): Case["messages"] => [
	{ role: "user", text: `The id starts canary-${id}` },
	{ role: "assistant", text: "Go on." },
	{ role: "user", text: `${second} and it ends -tail` },
];

const splitAcross = (id: string, messages: Case["messages"]): Case => ({
	canaries: [`canary-${id}-tail`],
	canaryParts: { [`canary-${id}-tail`]: [`canary-${id}`, "-tail"] },
	expect: "phi",
	fragments: [],
	id,
	messages,
	strata: { carrier: strata.carrier, entry: "user", identifier: strata.identifier, transform: "split" },
});

/** A valid number the judge clears, so only a rule can seal it. */
const ssn = "078-05-1120";

const ruleOnly: Case = {
	canaries: [ssn],
	expect: "phi",
	fragments: [],
	id: "rule-only",
	messages: [
		{ role: "user", text: "Why does the import drop this member?" },
		{ role: "assistant", text: "Reading the log." },
		{ role: "tool", text: `member 4471 tax id ${ssn} rejected` },
		{ role: "assistant", text: "The row has no member id." },
		{ role: "user", text: "Now add a test for it." },
	],
	strata,
};

const ruleOff = Effect.gen(function* ruleOff() {
	const hit = Option.getOrThrow(firstHit(`tax id ${ssn}`));
	const rules = yield* Rules;
	const played = evaluate({ cases: [ruleOnly], synthetic: noSynthetic });

	const withRule = yield* played;

	const withoutRule = yield* Effect.provideService(
		played,
		Rules,
		pipe(
			rules,
			Array.filter(({ id }) => id !== hit.rule),
		),
	);

	assert.deepStrictEqual(withRule.leaks, []);
	assert.deepStrictEqual(withoutRule.leaks, [{ id: "rule-only", request: 2, strata }]);
});

const boundsHold = Effect.sync(() => {
	for (const { cases, misses, upper } of bounds) {
		assert.closeTo(missRateUpperBound({ cases, misses }), upper, fourDecimals);
	}

	assert.strictEqual(missRateUpperBound({ cases: 5, misses: 5 }), certain);
});

const sealedThenStubbed = Effect.gen(function* sealedThenStubbed() {
	const { sent } = yield* play(sealed);

	const shown = pipe(
		sent,
		Array.map((each) => ({
			canary: each.lane === "clean" && Str.includes("canary-sealed")(each.view),
			lane: each.lane,
			stub: each.lane === "clean" && Str.includes(stubs.sealed)(each.view),
		})),
	);

	assert.deepStrictEqual(shown, [
		{ canary: false, lane: "clean", stub: false },
		{ canary: false, lane: "sealed", stub: false },
		{ canary: false, lane: "clean", stub: true },
	]);
});

const leakAtFirstShowing = Effect.gen(function* leakAtFirstShowing() {
	const report = yield* evaluate({ cases: [sealed, missed, clean], synthetic: noSynthetic });

	assert.deepStrictEqual(report.leaks, [{ id: "missed", request: 2, strata }]);
	assert.deepInclude(report.overRouting, {
		cases: 1,
		negative: "schema-only",
		onSealed: 0,
		overRouted: 0,
		requests: 2,
	});
	assert.deepStrictEqual(report.lanes, { clean: 7, sealed: 1 });
});

const splitApart = Effect.gen(function* splitApart() {
	const report = yield* evaluate({
		cases: [splitAcross("apart", splitMessages("apart", "Then")), splitAcross("cut", splitMessages("cut", "SEAL"))],
		synthetic: noSynthetic,
	});

	assert.deepStrictEqual(report.leaks, []);

	assert.deepStrictEqual(
		pipe(
			report.splits,
			Array.map(({ id, request }) => ({ id, request })),
		),
		[{ id: "apart", request: 2 }],
	);

	assert.deepStrictEqual(report.fragments, { cases: 1, shown: 1 });
});

const splitJoined = Effect.gen(function* splitJoined() {
	const joined = splitAcross("joined", [
		...splitMessages("joined", "Then"),
		{ role: "user", text: "So canary-joined-tail." },
	]);

	const report = yield* evaluate({ cases: [joined], synthetic: noSynthetic });

	assert.deepStrictEqual(
		pipe(
			report.leaks,
			Array.map(({ id }) => id),
		),
		["joined"],
	);

	assert.deepStrictEqual(report.splits, []);
});

const fragmentShown = Effect.gen(function* fragmentShown() {
	const withFragment = cleanCase("fragment", ["512-83"], [{ role: "user", text: "The SSN starts 512-83, why?" }]);
	const report = yield* evaluate({ cases: [withFragment], synthetic: noSynthetic });

	assert.deepStrictEqual(report.leaks, []);
	assert.deepStrictEqual(report.fragments, { cases: 1, shown: 1 });
});

const syntheticListed = Effect.gen(function* syntheticListed() {
	const listed = cleanCase(
		"synthetic-listed",
		[],
		[{ role: "user", text: "Eligibility times out for member SEAL-QA-17." }],
	);

	const played = (synthetic: Synthetic): ReturnType<typeof evaluate> => evaluate({ cases: [listed], synthetic });

	const exact = yield* played({ exact: ["SEAL-QA-17"], prefixes: [] });
	const prefixed = yield* played({ exact: [], prefixes: ["SEAL-QA"] });
	const unlisted = yield* played(noSynthetic);

	assert.deepStrictEqual(
		[exact.lanes, prefixed.lanes, unlisted.lanes],
		[
			{ clean: 1, sealed: 0 },
			{ clean: 1, sealed: 0 },
			{ clean: 0, sealed: 1 },
		],
	);
});

it.layer(Layer.mergeAll(Layer.succeed(Judge, judge), Digest.layerWebCrypto))("evaluate", (test) => {
	test.effect("the leak-rate bound is the exact one-sided Clopper-Pearson 95% upper limit", () => boundsHold);

	test.effect(
		"a sealed tool result goes to the sealed lane, and play returns to the clean lane without its canary in the guarded view",
		() => sealedThenStubbed,
	);

	test.effect(
		"a canary the judge clears is a leak at the request that first shows it, and a clean case stays on the clean lane",
		() => leakAtFirstShowing,
	);

	test.effect(
		"a split canary whose parts reached open accounts in two messages is reported apart and is no leak",
		() => splitApart,
	);

	test.effect("a valid SSN the judge clears is sealed by its rule, and leaks once that rule is off", () => ruleOff);

	test.effect("a split canary that one message shows whole is a leak, not a split", () => splitJoined);

	test.effect("a planted fragment on an open account is reported, never a leak", () => fragmentShown);

	test.effect(
		"the corpus's exact test identities reach the engine, so a case holding only them stays on the clean lane",
		() => syntheticListed,
	);
});
