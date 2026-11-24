import { Context, Effect, Layer } from "effect";
import { Digest } from "effect/crypto";
import { Judge } from "#router/client/judge/index.ts";
import type { JudgeName } from "#router/client/judge/index.ts";
import { NodeServices } from "@effect/platform-node";
import type { Report } from "./report.ts";
import { assert } from "@effect/vitest";
import { defaultCorpus } from "./default-corpus.ts";
import { evaluate } from "./evaluate.ts";
import { judgeOf } from "./judges.ts";

class DefaultCorpusPlay extends Context.Service<
	DefaultCorpusPlay,
	{ readonly leaks: Report["leaks"]; readonly unrecorded: number }
>()("phi-router/tools/corpus/default-corpus-replay/DefaultCorpusPlay") {}

const allRecorded = 0;

const playedWith = (name: JudgeName): Layer.Layer<DefaultCorpusPlay> =>
	Layer.effect(
		DefaultCorpusPlay,
		Effect.gen(function* played() {
			const replay = yield* judgeOf({ claude: name === "claude", name: "recorded" });
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

export { covered, noLeaks, playedWith };
