import { Array, Effect, Function, Number as Num, Option, Ref, Result, String as Str, pipe } from "effect";
import type { Call, Spend } from "./ask.ts";
import { Findings, Verdicts } from "./verdict.ts";
import type { IdentifierKind, Image, Piece, PieceKind } from "#router/features/policy/index.ts";
import type { JudgeFailed, Usage } from "#router/client/judge-failed.ts";
import {
	Rules,
	Synthetic,
	blankerOf,
	firstHitOf,
	identifierQuestion,
	judgeLimits,
	kindQuestion,
	thresholds,
} from "#router/features/policy/index.ts";
import { Judge } from "#router/client/judge.ts";
import type { JudgeInput } from "#router/client/judge.ts";
import type { Verdict } from "./verdict.ts";
import { ask } from "./ask.ts";
import { expand } from "./expand.ts";
import { unlisted } from "./fixtures.ts";

const noUsage: typeof Usage.Type = { calls: 0, cost: 0, inputTokens: 0, ms: 0 };

const plus = (sum: typeof Usage.Type, more: typeof Usage.Type): typeof Usage.Type => ({
	calls: sum.calls + more.calls,
	cost: sum.cost + more.cost,
	inputTokens: sum.inputTokens + more.inputTokens,
	ms: sum.ms + more.ms,
});

const judgeConcurrency = 8;

/** How the judge is asked about a piece: its calls, and the score below which it clears without the kind question. */
interface Asking extends Call {
	readonly kindBar: number;
}

/**
 * A system part goes on to the kind question only at a score that would seal any other piece, and a failed call on it is
 * asked once more.
 *
 * @param {boolean} system Whether the piece is a system part.
 * @param {Spend} spend Where the calls' cost goes.
 * @returns {Asking} How the judge is asked about it.
 */
const askingOf = (system: boolean, spend: Spend): Asking => {
	if (system) {
		return { kindBar: thresholds.sealAtOrAbove, retries: 1, spend };
	}

	return { kindBar: thresholds.clearBelow, retries: 0, spend };
};

const clearedByJudge = Verdicts.Cleared({ by: "judge" });

/**
 * A high score seals any piece but a system part, and the kind only labels it.
 *
 * @param {number} score The identifier question's score.
 * @param {boolean} system Whether the piece is a system part.
 * @returns {boolean} Whether the score seals whatever the kind call answers.
 */
const sealsOnScore = (score: number, system: boolean): boolean => !system && score >= thresholds.sealAtOrAbove;

/**
 * The verdict once a score reached the band and the kind call answered. Unless the score seals on its own, the kind
 * decides: a named kind seals, `none` clears.
 *
 * @param {object} root0 The kind call's answer, the score, and whether the piece is a system part.
 * @param {string} root0.kind The kind the judge named, or `none`.
 * @param {number} root0.score The identifier question's score.
 * @param {boolean} root0.system Whether the piece is a system part.
 * @returns {Verdict} The piece's verdict.
 */
const verdictOfKind = ({
	kind,
	score,
	system,
}: {
	readonly kind: IdentifierKind | "none";
	readonly score: number;
	readonly system: boolean;
}): Verdict => {
	if (kind !== "none") {
		return Verdicts.Sealed({ finding: Findings.Judge({ kind, score }) });
	}

	if (sealsOnScore(score, system)) {
		return Verdicts.Sealed({ finding: Findings.Judge({ kind: "unlabelled", score }) });
	}

	return clearedByJudge;
};

/**
 * The verdict once a score reached the band and the kind call failed: unlabelled when the score seals on its own, else
 * sealed as the failure.
 *
 * @param {object} root0 Why the kind call failed, the score, and whether the piece is a system part.
 * @param {string} root0.why Why the kind call failed.
 * @param {number} root0.score The identifier question's score.
 * @param {boolean} root0.system Whether the piece is a system part.
 * @returns {Verdict} The piece's verdict.
 */
const verdictOfFailedKind = ({
	why,
	score,
	system,
}: {
	readonly why: JudgeFailed["why"];
	readonly score: number;
	readonly system: boolean;
}): Verdict => {
	if (sealsOnScore(score, system)) {
		return Verdicts.Sealed({ finding: Findings.Judge({ kind: "unlabelled", score }) });
	}

	return Verdicts.Sealed({ finding: Findings.Failure({ why }) });
};

const judged = Effect.fn("judged")(function* judged({
	input,
	system,
	call,
}: {
	readonly input: JudgeInput;
	readonly system: boolean;
	readonly call: Asking;
}) {
	const judge = yield* Judge;
	const answer = yield* ask(() => judge.identifier(input, identifierQuestion), call);

	if (Result.isFailure(answer)) {
		return Verdicts.Sealed({ finding: Findings.Failure({ why: answer.failure.why }) });
	}

	const { score } = answer.success;

	if (score < call.kindBar) {
		return clearedByJudge;
	}

	const label = yield* ask(() => judge.kind(input, kindQuestion), call);

	return Result.match(label, {
		onFailure: ({ why }) => verdictOfFailedKind({ score, system, why }),
		onSuccess: ({ kind }) => verdictOfKind({ kind, score, system }),
	});
});

/**
 * Clears a piece with no text and no image left once fixtures are dropped: a fixture took its text, or it had none.
 *
 * @param {readonly string[]} kept The texts left once fixtures are dropped.
 * @param {readonly string[]} sent The texts as sent.
 * @param {readonly Image[]} images The piece's images.
 * @returns {Effect.Effect} Fails with the cleared verdict, or succeeds when something is left to read.
 */
const clearIfNothingLeft = (
	kept: readonly string[],
	sent: readonly string[],
	images: readonly Image[],
): Effect.Effect<void, Verdict> => {
	const blankTexts = pipe(
		kept,
		Array.every((text) => Str.isEmpty(Str.trim(text))),
	);

	if (!blankTexts || Array.isReadonlyArrayNonEmpty(images)) {
		return Effect.void;
	}

	if (kept.length < sent.length) {
		return Effect.fail(Verdicts.Cleared({ by: "fixture" }));
	}

	return Effect.fail(Verdicts.Cleared({ by: "empty" }));
};

/** Settles a piece before the judge. Failing with a verdict ends the piece there. */
const textOf = Effect.fn("textOf")(function* textOf(piece: Piece<string>, blank: (text: string) => string) {
	const texts = yield* unlisted(piece.texts);

	yield* clearIfNothingLeft(texts, piece.texts, piece.images);

	const expanded = expand(pipe(texts, Array.map(blank)));
	const readings = yield* Effect.mapError(expanded, (why) => Verdicts.Sealed({ finding: Findings.Failure({ why }) }));
	const text = blank(piece.seam) + Array.join(readings, "\n");
	const active = yield* Rules;
	const hit = firstHitOf(active)(text);

	if (Option.isSome(hit)) {
		return yield* Effect.fail(Verdicts.Sealed({ finding: Findings.Rule(hit.value) }));
	}

	return text;
});

/**
 * The image sets a piece's text is judged with: none, or the images `judgeLimits.maxImages` at a time.
 *
 * @param {JudgeInput["images"]} images The piece's images.
 * @returns {JudgeInput["images"][]} One set per judge call.
 */
const imageSetsOf = (images: JudgeInput["images"]): (readonly JudgeInput["images"][number][])[] => {
	if (Array.isReadonlyArrayNonEmpty(images)) {
		return Array.chunksOf(images, judgeLimits.maxImages);
	}

	return [images];
};

/** The judge's verdict on a piece's text. Images beyond one call's limit go in further calls with the same text. */
const judgedPiece = Effect.fn("judgedPiece")(function* judgedPiece({
	kind,
	input,
	spend,
}: {
	readonly kind: PieceKind;
	readonly input: JudgeInput;
	readonly spend: Spend;
}) {
	const system = kind === "system";
	const call = askingOf(system, spend);

	for (const images of imageSetsOf(input.images)) {
		const verdict = yield* judged({ call, input: { context: input.context, images, piece: input.piece }, system });

		if (Verdicts.$is("Sealed")(verdict)) {
			return verdict;
		}
	}

	return clearedByJudge;
});

const verdictOf = Effect.fnUntraced(
	function* verdictOf(piece: Piece<string>, spend: Spend) {
		const added = yield* Synthetic;
		const blank = blankerOf(added);
		const text = yield* textOf(piece, blank);

		if (piece.kind === "reply-open") {
			return Verdicts.Cleared({ by: "rules-only" });
		}

		const context = pipe(piece.context, Array.map(blank));

		const chars = pipe(
			context,
			Array.map((item) => item.length),
			Num.sumAll,
		);

		if (text.length + chars > judgeLimits.maxChars) {
			return Verdicts.Sealed({ finding: Findings.Failure({ why: "too-large" }) });
		}

		return yield* judgedPiece({ input: { context, images: piece.images, piece: text }, kind: piece.kind, spend });
	},
	Effect.match({ onFailure: Function.identity, onSuccess: Function.identity }),
);

/**
 * Verdicts for the pieces whose keys `known` does not hold, each key judged once. Never fails: a judge error, timeout,
 * refusal or unreadable input seals that one piece. An interruption propagates. Callers persist `found` themselves.
 */
const verdictsFor = Effect.fn("verdictsFor")(function* verdictsFor<Key extends string>(
	pieces: readonly Piece<Key>[],
	known: (key: Key) => boolean,
) {
	const byKey = new Map(
		pipe(
			pieces,
			Array.filter((piece) => !known(piece.key)),
			Array.map((piece) => [piece.key, piece] as const),
		),
	);

	const spent = yield* Ref.make(noUsage);
	const spend: Spend = (usage) => Ref.update(spent, (sum) => plus(sum, usage));

	const found = yield* Effect.forEach(
		byKey.values(),
		(piece) => Effect.map(verdictOf(piece, spend), (verdict) => [piece.key, verdict] as const),
		{ concurrency: judgeConcurrency },
	);

	return { found, usage: yield* Ref.get(spent) };
});

export { verdictsFor };
