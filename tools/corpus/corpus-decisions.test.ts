import { Array, Context, Effect, Layer, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import type { DrawReport } from "./gate-corpus.ts";
import { Judge } from "#router/client/judge/index.ts";
import { NodeServices } from "@effect/platform-node";
import { judgeOf } from "./judges.ts";
import { playGate } from "./gate-corpus.ts";

class GatePlay extends Context.Service<
	GatePlay,
	{ readonly reports: readonly DrawReport[]; readonly unrecorded: number }
>()("phi-router/tools/corpus/corpus-decisions.test/GatePlay") {}

const allRecorded = 0;

const played: Layer.Layer<GatePlay> = Layer.effect(
	GatePlay,
	Effect.gen(function* played() {
		const replay = yield* judgeOf({ name: "recorded" });
		const reports = yield* Effect.provideService(playGate, Judge, replay.judge);
		const unrecorded = yield* replay.unrecorded;

		return GatePlay.of({ reports, unrecorded });
	}),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, Digest.layerWebCrypto)), Layer.orDie);

const covered = Effect.gen(function* covered() {
	const { unrecorded } = yield* GatePlay;

	assert.strictEqual(unrecorded, allRecorded);
});

const noLeaks = Effect.gen(function* noLeaks() {
	const { reports } = yield* GatePlay;

	const leaks = pipe(
		reports,
		Array.flatMap(({ seed, report }) =>
			pipe(
				report.leaks,
				Array.map(({ id, strata }) => ({ id, seed, strata })),
			),
		),
	);

	assert.deepStrictEqual(leaks, []);
});

it.layer(played, { timeout: "10 minutes" })("the gated draws with the Decisions judge", (test) => {
	test.effect("the recorded answers cover every judge call of every gated draw", () => covered);

	test.effect("no complete identifier in a gated draw reaches an open account in one message", () => noLeaks);
});
