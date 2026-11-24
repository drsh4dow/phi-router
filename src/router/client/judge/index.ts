import { Context, Effect, Layer, Struct } from "effect";
import type { JudgeFailed, Usage } from "./failed.ts";
import { chosenJudge, claudeOnSealed } from "./choice.ts";
import type { ChosenJudge } from "./choice.ts";
import { UserDirectories } from "effect/persistence";
import { claude } from "./claude.ts";
import { decisions } from "./decisions.ts";
import { upstreamHttp } from "#router/client/accounts/index.ts";

interface JudgeInput {
	readonly piece: string;
	readonly context: readonly string[];
	readonly images: readonly { readonly mimeType: string; readonly data: string }[];
}

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

type JudgeName = "claude" | "decisions";

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

class Judge extends Context.Service<Judge, Asking & { readonly name: JudgeName; readonly model: string }>()(
	"phi-router/router/client/judge/Judge",
) {
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

export { defaultJudgeModels } from "./choice.ts";

export { JudgeFailed } from "./failed.ts";

export type { Usage } from "./failed.ts";
