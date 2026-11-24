import { Duration, Effect, Result } from "effect";
import { JudgeFailed } from "#router/client/judge/index.ts";
import type { Usage } from "#router/client/judge/index.ts";
import { judgeLimits } from "#router/features/policy/index.ts";

/** Adds what one judge call cost to the verdicts' running total. */
type Spend = (usage: typeof Usage.Type) => Effect.Effect<void>;

/** Where a piece's judge calls' cost goes, and how often a failed one is asked again. */
interface Call {
	readonly spend: Spend;
	readonly retries: number;
}

/**
 * One judge question under the policy's timeout, asked again up to `retries` times, its cost passed to `spend`. A failed
 * call still counts as a call, with the usage it carries when it billed. An interruption is not a failure, so it propagates.
 */
const ask = Effect.fnUntraced(function* ask<Answer extends { readonly usage: typeof Usage.Type }>(
	question: () => Effect.Effect<Answer, JudgeFailed>,
	{ spend, retries }: Call,
) {
	const timedOut = Effect.fail(JudgeFailed.make({ why: "judge-timeout" }));

	const attempt = Effect.suspend(question).pipe(
		Effect.timeoutOrElse({ duration: judgeLimits.timeoutMs, orElse: () => timedOut }),
		Effect.result,
		Effect.timed,
		Effect.flatMap(([elapsed, answer]) => {
			const measured = { calls: 1, cost: 0, inputTokens: 0, ms: Duration.toMillis(elapsed) };

			const usage = Result.match(answer, {
				onFailure: (failed) => failed.usage ?? measured,
				onSuccess: (found) => found.usage,
			});

			return Effect.andThen(spend(usage), Effect.fromResult(answer));
		}),
	);

	return yield* Effect.result(Effect.retry(attempt, { times: retries }));
});

export { ask };

export type { Call, Spend };
