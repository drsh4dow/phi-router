import { Context, Effect, FileSystem, Layer } from "effect";
import { assert, it } from "@effect/vitest";
import { recordedJudge, recordingsPath } from "./recorded.ts";
import { Digest } from "effect/crypto";
import { Judge } from "#router/client/judge.ts";
import { NodeServices } from "@effect/platform-node";
import type { Report } from "./report.ts";
import { defaultCorpus } from "./default-corpus.ts";
import { evaluate } from "./evaluate.ts";

/** The default corpus played once with the recorded judge: its leaks and the judge calls the recordings lack. */
class DefaultCorpusPlay extends Context.Service<
	DefaultCorpusPlay,
	{ readonly leaks: Report["leaks"]; readonly unrecorded: number }
>()("phi-router/tools/corpus/corpus.test/DefaultCorpusPlay") {}

const allRecorded = 0;

const played = Layer.effect(
	DefaultCorpusPlay,
	Effect.gen(function* played() {
		const fs = yield* FileSystem.FileSystem;
		const contents = yield* fs.readFileString(recordingsPath);
		const replay = yield* recordedJudge(contents);
		const { cases, synthetic } = yield* defaultCorpus;
		const report = yield* Effect.provideService(evaluate({ cases, synthetic }), Judge, replay.judge);
		const unrecorded = yield* replay.unrecorded;

		return DefaultCorpusPlay.of({ leaks: report.leaks, unrecorded });
	}),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, Digest.layerWebCrypto)));

const covered = Effect.gen(function* covered() {
	const { unrecorded } = yield* DefaultCorpusPlay;

	assert.strictEqual(unrecorded, allRecorded);
});

const noLeaks = Effect.gen(function* noLeaks() {
	const { leaks } = yield* DefaultCorpusPlay;

	assert.deepStrictEqual(leaks, []);
});

it.layer(played, { timeout: "120 seconds" })("the default corpus", (test) => {
	test.effect("the recorded Decisions answers cover every judge call of the default corpus", () => covered);

	test.effect("no complete identifier in the default corpus reaches an open account in one message", () => noLeaks);
});
