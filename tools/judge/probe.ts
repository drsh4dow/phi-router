import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import { identifierQuestion, judgeLimits, thresholds } from "#router/features/policy/index.ts";
import { Judge } from "#router/client/judge/index.ts";
import { judgeFromConfiguration } from "./live.ts";

const canarySsnSentence = "The patient's Social Security number is 923-41-0187.";

const costDigits = 3;

const probe = Effect.gen(function* probe() {
	const judge = yield* Judge;
	const { sealAtOrAbove } = thresholds;
	const asked = judge.identifier({ context: [], images: [], piece: canarySsnSentence }, identifierQuestion);
	const { score, usage } = yield* Effect.timeout(asked, judgeLimits.timeoutMs);

	yield* Console.log(`decisions judge on ${judge.model}`);
	yield* Console.log(`score ${String(score)}, seals at ${String(sealAtOrAbove)}`);
	yield* Console.log(
		`${String(usage.inputTokens)} input tokens, $${usage.cost.toPrecision(costDigits)}, ${String(Math.round(usage.ms))} ms`,
	);

	return { score, sealAtOrAbove };
}).pipe(
	Effect.filterOrFail(
		({ score, sealAtOrAbove }) => score >= sealAtOrAbove,
		({ score }) => `The judge scored the canary ${String(score)}, below the seal threshold.`,
	),
);

BunRuntime.runMain(Effect.provide(probe, Layer.provide(judgeFromConfiguration, BunServices.layer)));
