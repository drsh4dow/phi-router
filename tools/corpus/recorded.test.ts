import { Array, Effect, Option, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { identifierKind, identifierQuestion, kindQuestion } from "#router/features/policy/index.ts";
import { recordedJudge, recording } from "./recorded.ts";
import { Digest } from "effect/crypto";
import { Judge } from "#router/client/judge.ts";
import { JudgeFailed } from "#router/client/judge-failed.ts";

const usage = { calls: 1, cost: 0.002, inputTokens: 120, ms: 300 };

const replayedUsage = { calls: usage.calls, cost: usage.cost, inputTokens: usage.inputTokens, ms: 0 };

const allRecorded = 0;

const oneUnrecorded = 1;

const live = Judge.of({
	identifier: () => Effect.succeed({ score: 0.31, usage }),
	kind: (_input, question) =>
		pipe(
			question.criteria,
			Array.findFirst(([choice]) => choice === identifierKind.patientName),
			Option.match({
				onNone: () => Effect.fail(JudgeFailed.make({ why: "judge-error" })),
				onSome: ([choice]) => Effect.succeed({ kind: choice, usage }),
			}),
		),
	model: "scripted",
	name: "decisions",
});

const asked = { context: ["[user] why is this row rejected?"], images: [], piece: "patient Jane Roe" };

const replay = Effect.gen(function* replay() {
	const recorder = yield* recording(live);

	yield* recorder.judge.identifier(asked, identifierQuestion);
	yield* recorder.judge.kind(asked, kindQuestion);

	const contents = yield* recorder.contents;

	return yield* recordedJudge(contents, "decisions");
});

const replaysAnswers = Effect.gen(function* replaysAnswers() {
	const replayed = yield* replay;
	const identifier = yield* replayed.judge.identifier(asked, identifierQuestion);
	const kind = yield* replayed.judge.kind(asked, kindQuestion);
	const unrecorded = yield* replayed.unrecorded;

	assert.deepStrictEqual(identifier, { score: 0.31, usage: replayedUsage });
	assert.deepStrictEqual(kind, { kind: identifierKind.patientName, usage: replayedUsage });
	assert.strictEqual(unrecorded, allRecorded);
});

const failsUnrecorded = Effect.gen(function* failsUnrecorded() {
	const replayed = yield* replay;

	const failure = yield* Effect.flip(
		replayed.judge.identifier({ context: [], images: asked.images, piece: asked.piece }, identifierQuestion),
	);

	const unrecorded = yield* replayed.unrecorded;

	assert.instanceOf(failure, JudgeFailed);
	assert.strictEqual(unrecorded, oneUnrecorded);
});

it.layer(Digest.layerWebCrypto)("the recorded judge", (test) => {
	test.effect("a recorded call replays its answer and what it cost", () => replaysAnswers);

	test.effect(
		"a call the file lacks, even one differing only in its context, fails and counts as unrecorded",
		() => failsUnrecorded,
	);
});
