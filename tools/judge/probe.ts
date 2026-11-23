import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import { identifierQuestion, judgeLimits, thresholds } from "#router/features/policy/index.ts";
import { Configuration } from "#router/client/configuration.ts";
import { Judge } from "#router/client/judge.ts";
import { liveJudge } from "./live.ts";

/** A canary SSN in a labelled sentence. Area 923 was never issued, so it names no one. */
const sentence = "The patient's Social Security number is 923-41-0187.";

const costDigits = 3;

const probe = Effect.gen(function* probe() {
	const { judge: named } = yield* Configuration;
	const judge = yield* Judge;
	const asked = judge.identifier({ context: [], images: [], piece: sentence }, identifierQuestion);
	const { score, usage } = yield* Effect.timeout(asked, judgeLimits.timeoutMs);

	yield* Console.log(`judge ${named.model} at ${named.endpoint}`);
	yield* Console.log(`score ${String(score)}, seals at ${String(thresholds.sealAtOrAbove)}`);
	yield* Console.log(
		`${String(usage.inputTokens)} input tokens, $${usage.cost.toPrecision(costDigits)}, ${String(Math.round(usage.ms))} ms`,
	);

	return score;
}).pipe(
	Effect.filterOrFail(
		(score) => score >= thresholds.sealAtOrAbove,
		(score) => `The judge scored the canary ${String(score)}, below the seal threshold.`,
	),
);

BunRuntime.runMain(Effect.provide(probe, Layer.provide(liveJudge, BunServices.layer)));
