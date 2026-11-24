import { Array, Effect, Option, pipe } from "effect";
import type { ChoiceQuestion, JudgeInput } from "#router/client/judge/index.ts";
import type { IdentifierKind, Piece } from "#router/features/policy/index.ts";
import { Judge, JudgeFailed } from "#router/client/judge/index.ts";
import { Seam, firstHit, identifierKindNames } from "#router/features/policy/index.ts";
import type { ContentKey } from "#router/primitives/content-key.ts";
import { contentKey } from "#router/primitives/content-key.ts";
import { verdictsFor } from "./engine.ts";

type Answer<Value> = Value | "error" | "refused";

type Question = "identifier" | "kind";

interface Script {
	readonly score: (input: JudgeInput) => Answer<number>;
	readonly kind?: (input: JudgeInput) => Answer<IdentifierKind | "none">;
}

interface Asked {
	readonly question: Question;
	readonly input: JudgeInput;
}

interface Scripted {
	readonly judge: Judge["Service"];
	readonly asked: readonly Asked[];
}

const ssnHit = Option.getOrThrow(firstHit("Patient SSN 078-05-1120 on file"));

const namedKind = Option.getOrThrow(Array.head(identifierKindNames));

const usage = { calls: 1, cost: 0.001, inputTokens: 10, ms: 5 };

const answered = <Value>(answer: Answer<Value>): Effect.Effect<Value, JudgeFailed> => {
	if (answer === "error") {
		return Effect.fail(JudgeFailed.make({ why: "judge-error" }));
	}

	if (answer === "refused") {
		return Effect.fail(JudgeFailed.make({ why: "judge-refused" }));
	}

	return Effect.succeed(answer);
};

const choiceOf = <Choice extends string>(
	question: ChoiceQuestion<Choice>,
	kind: string,
): Effect.Effect<{ readonly kind: Choice; readonly usage: typeof usage }, JudgeFailed> =>
	pipe(
		question.criteria,
		Array.findFirst(([choice]) => choice === kind),
		Option.match({
			onNone: () => Effect.fail(JudgeFailed.make({ why: "judge-error" })),
			onSome: ([choice]) => Effect.succeed({ kind: choice, usage }),
		}),
	);

const scripted = ({ score, kind = (): Answer<IdentifierKind | "none"> => "none" }: Script): Scripted => {
	const asked: Asked[] = [];

	const judge = Judge.of({
		identifier: (input) => {
			asked.push({ input, question: "identifier" });

			return Effect.map(answered(score(input)), (found) => ({ score: found, usage }));
		},
		kind: (input, question) => {
			asked.push({ input, question: "kind" });

			return Effect.flatMap(answered(kind(input)), (found) => choiceOf(question, found));
		},
		model: "scripted",
		name: "decisions",
	});

	return { asked, judge };
};

const pieceOf = Effect.fnUntraced(function* pieceOf(text: string) {
	const piece: Piece<typeof ContentKey.Type> = {
		context: [],
		images: [],
		key: yield* contentKey([text]),
		kind: "user",
		seam: Seam.make({ text: "" }),
		texts: [text],
	};

	return piece;
});

const judgeAll = Effect.fnUntraced(function* judgeAll<Key extends string>({
	pieces,
	script,
	known = (): boolean => false,
}: {
	readonly pieces: readonly Piece<Key>[];
	readonly script: Script;
	readonly known?: (key: Key) => boolean;
}) {
	const { judge, asked } = scripted(script);
	const { found, usage: spent } = yield* Effect.provideService(verdictsFor(pieces, known), Judge, judge);

	return { asked, found, usage: spent };
});

const judgedOne = Effect.fnUntraced(function* judgedOne({
	piece,
	script,
}: {
	readonly piece: Piece<string>;
	readonly script: Script;
}) {
	const { found, asked } = yield* judgeAll({ pieces: [piece], script });

	return {
		fresh: pipe(
			asked,
			Array.map(({ input }) => input.piece),
		),
		questions: pipe(
			asked,
			Array.map(({ question }) => question),
		),
		verdicts: pipe(
			found,
			Array.map(([, verdict]) => verdict),
		),
	};
});

export { judgeAll, judgedOne, namedKind, pieceOf, scripted, ssnHit };

export type { Question, Script };
