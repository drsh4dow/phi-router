import { Context, Effect, Layer, Struct } from "effect";
import type { JudgeFailed, Usage } from "./judge-failed.ts";
import { chosenJudge, claudeOnSealed } from "./judge-choice.ts";
import type { ChosenJudge } from "./judge-choice.ts";
import { UserDirectories } from "effect/persistence";
import { claude } from "./judge-claude.ts";
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

/** The two judges: OpenAI Decisions, and Claude through a BAA account's Messages API. */
type JudgeName = "claude" | "decisions";

/** The transport-free judge's two questions. */
interface Asking {
	readonly identifier: (
		input: JudgeInput,
		question: ScoreQuestion,
	) => Effect.Effect<{ readonly score: number; readonly usage: typeof Usage.Type }, JudgeFailed>;
	readonly kind: <Choice extends string>(
		input: JudgeInput,
		question: ChoiceQuestion<Choice>,
	) => Effect.Effect<{ readonly kind: Choice; readonly usage: typeof Usage.Type }, JudgeFailed>;
}

/** The chosen judge's client, with its name and model. */
const askingOf = Effect.fnUntraced(function* askingOf(chosen: ChosenJudge) {
	const named = { model: chosen.model, name: chosen.name };

	if (chosen.name === "claude") {
		const asking = yield* claude(chosen);

		return Struct.assign(asking, named);
	}

	const asking = yield* decisions(chosen);

	return Struct.assign(asking, named);
});

const judgeHttp = Layer.merge(upstreamHttp, UserDirectories.layer);

/**
 * The transport-free judge, with its name and the model it runs. `identifier` asks the policy's one question, `kind`
 * the kind question. The engine owns the thresholds, one set per judge, and the timeout, so every adapter seals the
 * same way. An adapter checks each answer against the question it was handed: a score outside 0 to 1, or a choice the
 * question does not list, fails as `judge-error`.
 */
class Judge extends Context.Service<Judge, Asking & { readonly name: JudgeName; readonly model: string }>()(
	"phi-router/router/client/judge",
) {
	/** The judge the configuration picks. */
	public static readonly layer = Layer.effect(Judge, chosenJudge.pipe(Effect.flatMap(askingOf))).pipe(
		Layer.provide(judgeHttp),
	);

	/** The Claude judge on the configuration's first Anthropic BAA account, whatever else it names. */
	public static readonly claudeLayer = Layer.effect(Judge, claudeOnSealed.pipe(Effect.flatMap(askingOf))).pipe(
		Layer.provide(judgeHttp),
	);
}

export { Judge };

export type { Asking, ChoiceQuestion, JudgeInput, JudgeName, ScoreQuestion };
