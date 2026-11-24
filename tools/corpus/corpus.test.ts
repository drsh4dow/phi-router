import { Context, Effect, FileSystem, Layer } from "effect";
import { assert, it } from "@effect/vitest";
import { recordedJudge, recordingsPaths } from "./recorded.ts";
import { Digest } from "effect/crypto";
import { Judge } from "#router/client/judge/index.ts";
import type { JudgeName } from "#router/client/judge/index.ts";
import { NodeServices } from "@effect/platform-node";
import type { Report } from "./report.ts";
import { defaultCorpus } from "./default-corpus.ts";
import { evaluate } from "./evaluate.ts";

class DefaultCorpusPlay extends Context.Service<
	DefaultCorpusPlay,
	{ readonly leaks: Report["leaks"]; readonly unrecorded: number }
>()("phi-router/tools/corpus/corpus.test/DefaultCorpusPlay") {}

const allRecorded = 0;

const playedWith = (name: JudgeName): Layer.Layer<DefaultCorpusPlay> =>
	Layer.effect(
		DefaultCorpusPlay,
		Effect.gen(function* played() {
			const fs = yield* FileSystem.FileSystem;
			const contents = yield* fs.readFileString(recordingsPaths[name]);
			const replay = yield* recordedJudge(contents, name);
			const { cases, synthetic } = yield* defaultCorpus;
			const report = yield* Effect.provideService(evaluate({ cases, synthetic }), Judge, replay.judge);
			const unrecorded = yield* replay.unrecorded;

			return DefaultCorpusPlay.of({ leaks: report.leaks, unrecorded });
		}),
	).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, Digest.layerWebCrypto)), Layer.orDie);

const covered = Effect.gen(function* covered() {
	const { unrecorded } = yield* DefaultCorpusPlay;

	assert.strictEqual(unrecorded, allRecorded);
});

const noLeaks = Effect.gen(function* noLeaks() {
	const { leaks } = yield* DefaultCorpusPlay;

	assert.deepStrictEqual(leaks, []);
});

it.layer(playedWith("decisions"), { timeout: "10 minutes" })("the default corpus with the Decisions judge", (test) => {
	test.effect("the recorded answers cover every judge call of the default corpus", () => covered);

	test.effect("no complete identifier in the default corpus reaches an open account in one message", () => noLeaks);
});

it.layer(playedWith("claude"), { timeout: "10 minutes" })("the default corpus with the Claude judge", (test) => {
	test.effect("the recorded answers cover every judge call of the default corpus", () => covered);

	test.effect("no complete identifier in the default corpus reaches an open account in one message", () => noLeaks);
});
