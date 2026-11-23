import { Context, Effect, Layer } from "effect";
import type { JudgeFailed, Usage } from "./judge-failed.ts";
import { Configuration } from "./configuration.ts";
import { decisions } from "./judge-decisions.ts";
import { upstreamHttp } from "./upstream-http.ts";

/** What the judge reads: the piece's text, cleared context beside it, and the piece's images. */
interface JudgeInput {
	readonly piece: string;
	readonly context: readonly string[];
	/** At most `judgeLimits.maxImages`, each base64 `data` with its `mimeType`. */
	readonly images: readonly { readonly mimeType: string; readonly data: string }[];
}

/** A question the judge answers with a score from 0 to 1, the chance that `true` holds. */
interface ScoreQuestion {
	readonly type: "bool";
	readonly instructions: string;
	readonly criteria: { readonly true: string; readonly false: string };
}

/** A question the judge answers with one of its choices, listed in the order the judge reads them. */
interface ChoiceQuestion<Choice extends string> {
	readonly type: "choice";
	readonly instructions: string;
	readonly criteria: readonly (readonly [Choice, string])[];
}

/**
 * The transport-free judge. `identifier` asks the policy's one question, `kind` the kind question. The engine owns the
 * thresholds and the timeout, so every adapter seals the same way. An adapter checks each answer against the question
 * it was handed: a score outside 0 to 1, or a choice the question does not list, fails as `judge-error`.
 */
class Judge extends Context.Service<
	Judge,
	{
		readonly identifier: (
			input: JudgeInput,
			question: ScoreQuestion,
		) => Effect.Effect<{ readonly score: number; readonly usage: typeof Usage.Type }, JudgeFailed>;
		readonly kind: <Choice extends string>(
			input: JudgeInput,
			question: ChoiceQuestion<Choice>,
		) => Effect.Effect<{ readonly kind: Choice; readonly usage: typeof Usage.Type }, JudgeFailed>;
	}
>()("phi-router/router/client/judge") {
	public static readonly layer = Layer.effect(
		Judge,
		Effect.gen(function* make() {
			const { judge } = yield* Configuration;
			const asking = yield* decisions(judge);

			return Judge.of(asking);
		}),
	).pipe(Layer.provide(upstreamHttp));
}

export { Judge };

export type { ChoiceQuestion, JudgeInput, ScoreQuestion };
