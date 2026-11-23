import { Array, Effect, Schema, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { autoOf, clean, harnessNames, holdsCanary, modelsIn, named, phi, posted } from "./target-models.ts";
import { fakes, jsonText } from "./harnesses.ts";
import type { HarnessName } from "./target-models.ts";
import { NodeServices } from "@effect/platform-node";
import { routed } from "./mocked-router.ts";

const ok = 200;

const pastAuto = 1;

const JsonOf = Schema.fromJsonString(Schema.Unknown);

/**
 * A clean request reaches the open account under the model it named, byte for byte as its `model` field, and
 * `phi/auto` under the target model. Nothing reaches the BAA account and no credential crosses.
 */
const keptClean = Effect.fnUntraced(function* keptClean(harness: HarnessName) {
	const { breaches, mocks, post } = yield* routed({ harness, holdsPhi: holdsCanary });
	const asked = [autoOf[harness], named.subagent, named.reviewer, named.gateway];

	yield* Effect.forEach(
		asked,
		(model, at) => posted(post, { harness, model, session: `kept-${String(at)}` }, [clean]),
		{ concurrency: 1 },
	);

	const opened = yield* mocks.open.received;
	const sealed = yield* mocks.baa.received;
	const models = yield* modelsIn(opened);

	const verbatim = yield* Effect.forEach(
		Array.zip(Array.drop(opened, pastAuto), Array.drop(asked, pastAuto)),
		([sent, model]) => Effect.map(jsonText(model), (field) => Str.includes(`"model":${field}`)(sent.body)),
		{ concurrency: 1 },
	);

	const found = yield* breaches;

	assert.deepStrictEqual<unknown>(
		{ breaches: found, models, sealed: sealed.length, verbatim },
		{
			breaches: [],
			models: [fakes.targetModel, named.subagent, named.reviewer, named.gateway],
			sealed: 0,
			verbatim: [true, true, true],
		},
	);
});

/**
 * A canary request under each of five model names adds judge calls that hold the canary, runs sealed, and never
 * reaches the open account.
 */
const judgedUnderEach = Effect.fnUntraced(function* judgedUnderEach(harness: HarnessName) {
	const { mocks, post } = yield* routed({ harness, holdsPhi: holdsCanary });
	const asked = [autoOf[harness], named.subagent, named.sonnet, named.reviewer, named.memories];

	const canaryJudgments = mocks.judge.received.pipe(
		Effect.flatMap((judged) =>
			Effect.forEach(judged, (call) => Schema.encodeUnknownEffect(JsonOf)(call), { concurrency: 1 }),
		),
		Effect.map(Array.countBy(holdsCanary)),
	);

	const each = yield* Effect.forEach(
		asked,
		(model, at) =>
			Effect.gen(function* judgedOnce() {
				const before = yield* canaryJudgments;
				const status = yield* posted(post, { harness, model, session: `judged-${String(at)}` }, [phi]);
				const after = yield* canaryJudgments;

				return { judged: after > before, status };
			}),
		{ concurrency: 1 },
	);

	const opened = yield* mocks.open.received;
	const sealed = yield* mocks.baa.received;

	assert.deepStrictEqual<unknown>(
		{
			each,
			opened: opened.length,
			sealed: pipe(
				sealed,
				Array.map(({ body }) => holdsCanary(body)),
			),
		},
		{
			each: Array.replicate({ judged: true, status: ok }, asked.length),
			opened: 0,
			sealed: Array.replicate(true, asked.length),
		},
	);
});

it.layer(NodeServices.layer)("a request's target model", (test) => {
	test.effect.each(harnessNames)(
		"%s: a clean request reaches the open account under the model it named, and phi/auto under the target model",
		keptClean,
	);
	test.effect.each(harnessNames)(
		"%s: a canary request under each of five model names is judged and never reaches the open account",
		judgedUnderEach,
	);
});
