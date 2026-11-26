import { Array, Effect, Schema, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { autoOf, clean, harnessNames, holdsCanary, modelsIn, phi, posted, sentModels } from "./target-models.ts";
import { fakes, jsonText } from "./harnesses.ts";
import type { HarnessName } from "./target-models.ts";
import { NodeServices } from "@effect/platform-node";
import { handleAt } from "#router/primitives/handle.ts";
import { routed } from "./mocked-router.ts";
import { sealedStub } from "#router/features/border/index.ts";

const firstSequence = 1;

const h1 = handleAt(firstSequence);

const ok = 200;

const pastAuto = 1;

const JsonOf = Schema.fromJsonString(Schema.Unknown);

const keptClean = Effect.fnUntraced(function* keptClean(harness: HarnessName) {
	const { breaches, mocks, post } = yield* routed({ harness, holdsPhi: holdsCanary });
	const asked = [autoOf[harness], sentModels.claudeHaiku, sentModels.codexReviewer, sentModels.gatewayWithSlash];

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
			models: [fakes.targetModel, sentModels.claudeHaiku, sentModels.codexReviewer, sentModels.gatewayWithSlash],
			sealed: 0,
			verbatim: [true, true, true],
		},
	);
});

const judgedUnderEach = Effect.fnUntraced(function* judgedUnderEach(harness: HarnessName) {
	const { mocks, post } = yield* routed({ harness, holdsPhi: holdsCanary });

	const asked = [
		autoOf[harness],
		sentModels.claudeHaiku,
		sentModels.claudeSonnet,
		sentModels.codexReviewer,
		sentModels.codexMemories,
	];

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
	const stub = yield* jsonText(sealedStub(harness)(h1));

	assert.deepStrictEqual<unknown>(
		{
			each,
			opened: pipe(
				opened,
				Array.map(({ body }) => ({ canary: holdsCanary(body), stubbed: Str.includes(stub)(body) })),
			),
			sealed: sealed.length,
		},
		{
			each: Array.replicate({ judged: true, status: ok }, asked.length),
			opened: Array.replicate({ canary: false, stubbed: true }, asked.length),
			sealed: 0,
		},
	);
});

it.layer(NodeServices.layer)("a request's target model", (test) => {
	test.effect.each(harnessNames)(
		"%s: a clean request reaches the open account under the model it named, byte for byte as its model field, and phi/auto under the target model, with nothing at the BAA account and no credential crossing",
		keptClean,
	);
	test.effect.each(harnessNames)(
		"%s: a canary request under each of five model names adds judge calls that hold the canary, and reaches the open account with the stub in place of the canary and nothing at the BAA account",
		judgedUnderEach,
	);
});
