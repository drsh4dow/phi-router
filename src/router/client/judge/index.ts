import { Context, Effect, Layer, Struct } from "effect";
import type { JudgeFailed, Usage } from "./failed.ts";
import { decisions, decisionsModel } from "./decisions.ts";
import { UserDirectories } from "effect/persistence";
import { chosenJudge } from "./choice.ts";
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

interface ChoiceQuestion<Choice extends string> {
	readonly type: "choice";
	readonly instructions: string;
	readonly criteria: readonly (readonly [Choice, string])[];
}

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

const judgeHttp = Layer.merge(upstreamHttp, UserDirectories.layer);

class Judge extends Context.Service<Judge, Asking & { readonly model: string }>()(
	"phi-router/router/client/judge/Judge",
) {
	public static readonly layer = Layer.effect(
		Judge,
		chosenJudge.pipe(
			Effect.flatMap(decisions),
			Effect.map((asking) => Struct.assign(asking, { model: decisionsModel })),
		),
	).pipe(Layer.provide(judgeHttp));
}

export { Judge };

export type { Asking, ChoiceQuestion, JudgeInput, ScoreQuestion };

export { decisionsModel } from "./decisions.ts";

export { JudgeFailed } from "./failed.ts";

export type { Usage } from "./failed.ts";
