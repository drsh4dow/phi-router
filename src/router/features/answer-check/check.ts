import type { AnswerCheck, AnswerChecked } from "#shared/cli.ts";
import { Array, Effect, Option, String as Str, pipe } from "effect";
import { Findings, Verdicts, verdictOfPiece } from "#router/features/verdicts/index.ts";
import type { IdentifierKind, RuleId } from "#router/features/policy/index.ts";
import type { PinnedRun, SealedStore } from "#router/client/sealed-store.ts";
import { Rules, Seam, identifierKinds, rewriteLimit, wayOut } from "#router/features/policy/index.ts";
import { stubTag } from "#router/primitives/handle.ts";

type Asked = typeof AnswerCheck.Type;

type Checked = typeof AnswerChecked.Type;

const none = 0;

const oneMore = 1;

const scoreDigits = 2;

const textImages = 0;

const cleared = (run: PinnedRun): PinnedRun => ({ gaveUp: run.gaveUp, inARow: none, rewrites: run.rewrites });

const sealedAgain = (run: PinnedRun): PinnedRun => {
	const inARow = Math.min(run.inARow + oneMore, rewriteLimit + oneMore);

	if (inARow > rewriteLimit) {
		return { gaveUp: run.gaveUp + oneMore, inARow, rewrites: run.rewrites };
	}

	return { gaveUp: run.gaveUp, inARow, rewrites: run.rewrites + oneMore };
};

const kindNamed = (kind: IdentifierKind): string =>
	pipe(
		identifierKinds,
		Array.findFirst(([each]) => each === kind),
		Option.match({ onNone: () => kind, onSome: ([, description]) => `${description} (${kind})` }),
	);

const matchedBy = Effect.fnUntraced(function* matchedBy(rule: RuleId, answer: string) {
	const active = yield* Rules;

	return pipe(
		active,
		Array.findFirst(({ id }) => id === rule),
		Option.flatMap(({ pattern }) => Str.match(pattern)(answer)),
		Option.map(([value]) => value),
	);
});

const judgedReason = (kind: IdentifierKind | "unlabelled", score: number): string => {
	const judged = `phi-router's judge scored it ${score.toFixed(scoreDigits)} for holding a direct identifier of a patient or member`;

	if (kind === "unlabelled") {
		return judged;
	}

	return `${judged}, most likely ${kindNamed(kind)}`;
};

const rewriteOf = (reason: string, attempt: number, filesFolder: string): string =>
	`phi-router withheld your last answer: ${reason}. The agent that started you runs on an account that must never see patient identifiers, so your answer must hold none. This is rewrite attempt ${String(attempt)} of ${String(rewriteLimit)}: answer again without them. ${wayOut(filesFolder)}`;

const checkAnswer = Effect.fn("checkAnswer")(function* checkAnswer(asked: Asked, store: SealedStore["Service"]) {
	const verdict = yield* verdictOfPiece({
		context: [],
		images: [],
		key: "answer",
		kind: "tool-result",
		seam: Seam.make({ text: "" }),
		texts: [asked.answer],
	});

	if (Verdicts.$is("Cleared")(verdict)) {
		yield* store.answered(asked.session, asked.subagent, cleared);

		return { outcome: "cleared" } satisfies Checked;
	}

	const run = yield* store.answered(asked.session, asked.subagent, sealedAgain);

	if (run.inARow <= rewriteLimit) {
		const folder = yield* store.filesFolder(asked.session);

		const reason = yield* Findings.$match(verdict.finding, {
			Failure: ({ why }) => Effect.succeed(`phi-router could not check it (${why})`),
			Judge: ({ kind, score }) => Effect.succeed(judgedReason(kind, score)),
			Quote: () => Effect.succeed("it quotes content phi-router withheld"),
			Rule: ({ kind, rule }) =>
				Effect.map(matchedBy(rule, asked.answer), (value) =>
					Option.match(value, {
						onNone: () => `it holds ${kindNamed(kind)} in an encoded or split form`,
						onSome: (matched) => `it holds ${kindNamed(kind)}: "${matched}"`,
					}),
				),
		});

		return {
			attempt: run.inARow,
			limit: rewriteLimit,
			message: rewriteOf(reason, run.inARow, folder),
			outcome: "rewrite",
		} satisfies Checked;
	}

	const key = `answer ${asked.subagent} ${String(run.gaveUp)}`;
	const handles = yield* store.keep(asked.session, [{ images: textImages, key, text: asked.answer }]);

	const handle = yield* Option.match(Option.fromUndefinedOr(handles.get(key)), {
		onNone: () => Effect.die("the sealed store kept the answer without a handle"),
		onSome: Effect.succeed,
	});

	return {
		handle,
		outcome: "gave-up",
		reply: `${stubTag(handle)} The pinned subagent's answer still held patient identifiers after ${String(rewriteLimit)} rewrites, so phi-router could not clear it and withheld it. ${handle} is its handle.`,
	} satisfies Checked;
});

export { checkAnswer };
