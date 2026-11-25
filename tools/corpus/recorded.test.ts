import { Array, Effect, FileSystem, Layer, Option, Record, Schema, String as Str, pipe } from "effect";
import { Judge, JudgeFailed } from "#router/client/judge/index.ts";
import { assert, it } from "@effect/vitest";
import { identifierKind, identifierQuestion, kindQuestion } from "#router/features/policy/index.ts";
import { recordedJudge, recording, recordingsPath } from "./recorded.ts";
import { Digest } from "effect/crypto";
import { NodeServices } from "@effect/platform-node";

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
});

const billedFailures = Judge.of({
	identifier: () => Effect.fail(JudgeFailed.make({ usage, why: "judge-refused" })),
	kind: () => Effect.fail(JudgeFailed.make({ usage, why: "judge-timeout" })),
	model: "scripted",
});

const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)));

const asked = { context: ["[user] why is this row rejected?"], images: [], piece: "patient Jane Roe" };

const replay = Effect.gen(function* replay() {
	const recorder = yield* recording(live);

	yield* recorder.judge.identifier(asked, identifierQuestion);
	yield* recorder.judge.kind(asked, kindQuestion);

	const contents = yield* recorder.contents;

	return yield* recordedJudge(contents);
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

const otherPolicyVersion = Effect.gen(function* otherPolicyVersion() {
	const recorder = yield* recording(live);

	yield* recorder.judge.identifier(asked, identifierQuestion);

	const contents = yield* recorder.contents;
	const replayed = yield* recordedJudge(Str.replace(/"policy":"[0-9a-f]+"/u, '"policy":"another"')(contents));
	const failure = yield* Effect.flip(replayed.judge.identifier(asked, identifierQuestion));
	const unrecorded = yield* replayed.unrecorded;

	assert.strictEqual(failure.why, "judge-error");
	assert.strictEqual(unrecorded, oneUnrecorded);
});

const keepsBilledFailures = Effect.gen(function* keepsBilledFailures() {
	const recorder = yield* recording(billedFailures);

	yield* Effect.flip(recorder.judge.identifier(asked, identifierQuestion));
	yield* Effect.flip(recorder.judge.kind(asked, kindQuestion));

	const contents = yield* recorder.contents;
	const replayed = yield* recordedJudge(contents);
	const refused = yield* Effect.flip(replayed.judge.identifier(asked, identifierQuestion));
	const timedOut = yield* Effect.flip(replayed.judge.kind(asked, kindQuestion));
	const unrecorded = yield* replayed.unrecorded;

	assert.deepStrictEqual([refused.why, refused.usage], ["judge-refused", replayedUsage]);
	assert.strictEqual(timedOut.why, "judge-error");
	assert.strictEqual(unrecorded, oneUnrecorded);
});

const fieldsOfFirstLine = (contents: string): Effect.Effect<string[], Schema.SchemaError> =>
	pipe(Str.split("\n")(contents), Array.headNonEmpty, decodeLine, Effect.map(Record.keys));

const committedFieldOrder = Effect.gen(function* committedFieldOrder() {
	const fs = yield* FileSystem.FileSystem;
	const recorder = yield* recording(live);

	yield* recorder.judge.identifier(asked, identifierQuestion);

	const contents = yield* recorder.contents;
	const written = yield* fieldsOfFirstLine(contents);

	const committed = yield* pipe(fs.readFileString(recordingsPath), Effect.flatMap(fieldsOfFirstLine));

	assert.deepStrictEqual(committed, written);
});

it.layer(Layer.mergeAll(Digest.layerWebCrypto, NodeServices.layer))("the recorded judge", (test) => {
	test.effect("a recorded call replays its answer and what it cost", () => replaysAnswers);

	test.effect(
		"a call the file lacks, even one differing only in its context, fails and counts as unrecorded",
		() => failsUnrecorded,
	);

	test.effect(
		"a call recorded under another policy version fails as a judge error and counts as unrecorded",
		() => otherPolicyVersion,
	);

	test.effect(
		"a recording keeps a refusal the judge billed and drops a timeout, which replays as unrecorded",
		() => keepsBilledFailures,
	);

	test.effect(
		"a recording writes its fields in the order the committed recordings file holds",
		() => committedFieldOrder,
	);
});
