import { Array, Effect, Function, Number as Num, Option, Ref, Result, String as Str, pipe } from "effect";
import type { Call, Spend } from "./ask.ts";
import { Findings, Verdicts } from "./verdict.ts";
import type { IdentifierKind, Image, Piece, PieceKind } from "#router/features/policy/index.ts";
import type { JudgeFailed, JudgeInput, Usage } from "#router/client/judge/index.ts";
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
import { Judge } from "#router/client/judge/index.ts";
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

interface Asking extends Call {
	readonly askKindAtOrAbove: number;
	readonly sealAtOrAbove: number;
}

type Thresholds = (typeof thresholds)[keyof typeof thresholds];

const askingOf = (system: boolean, spend: Spend, { clearBelow, sealAtOrAbove }: Thresholds): Asking => {
	if (system) {
		return { askKindAtOrAbove: sealAtOrAbove, retries: 1, sealAtOrAbove, spend };
	}

	return { askKindAtOrAbove: clearBelow, retries: 0, sealAtOrAbove, spend };
};

const clearedByJudge = Verdicts.Cleared({ by: "judge" });

interface Scored {
	readonly score: number;
	readonly system: boolean;
	readonly sealAtOrAbove: number;
}

const sealsOnScore = ({ score, system, sealAtOrAbove }: Scored): boolean => !system && score >= sealAtOrAbove;

const verdictOfKind = ({
	kind,
	scored,
}: {
	readonly kind: IdentifierKind | "none";
	readonly scored: Scored;
}): Verdict => {
	if (kind !== "none") {
		return Verdicts.Sealed({ finding: Findings.Judge({ kind, score: scored.score }) });
	}

	if (sealsOnScore(scored)) {
		return Verdicts.Sealed({ finding: Findings.Judge({ kind: "unlabelled", score: scored.score }) });
	}

	return clearedByJudge;
};

const verdictOfFailedKind = ({
	why,
	scored,
}: {
	readonly why: JudgeFailed["why"];
	readonly scored: Scored;
}): Verdict => {
	if (sealsOnScore(scored)) {
		return Verdicts.Sealed({ finding: Findings.Judge({ kind: "unlabelled", score: scored.score }) });
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

	if (score < call.askKindAtOrAbove) {
		return clearedByJudge;
	}

	const label = yield* ask(() => judge.kind(input, kindQuestion), call);

	const scored = { score, sealAtOrAbove: call.sealAtOrAbove, system };

	return Result.match(label, {
		onFailure: ({ why }) => verdictOfFailedKind({ scored, why }),
		onSuccess: ({ kind }) => verdictOfKind({ kind, scored }),
	});
});

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

	return Effect.fail(Verdicts.Cleared({ by: "nothing-to-judge" }));
};

const textOf = Effect.fn("textOf")(function* textOf(piece: Piece<string>, blank: (text: string) => string) {
	const texts = yield* unlisted(piece.texts);

	yield* clearIfNothingLeft(texts, piece.texts, piece.images);

	const expanded = expand(pipe(texts, Array.map(blank)));
	const readings = yield* Effect.mapError(expanded, (why) => Verdicts.Sealed({ finding: Findings.Failure({ why }) }));
	const text = blank(piece.seam.text) + Array.join(readings, "\n");
	const active = yield* Rules;
	const hit = firstHitOf(active)(text);

	if (Option.isSome(hit)) {
		return yield* Effect.fail(Verdicts.Sealed({ finding: Findings.Rule(hit.value) }));
	}

	return text;
});

const imageSetsOf = (images: JudgeInput["images"]): (readonly JudgeInput["images"][number][])[] => {
	if (Array.isReadonlyArrayNonEmpty(images)) {
		return Array.chunksOf(images, judgeLimits.maxImages);
	}

	return [images];
};

const judgedPiece = Effect.fn("judgedPiece")(function* judgedPiece({
	kind,
	input,
	spend,
}: {
	readonly kind: PieceKind;
	readonly input: JudgeInput;
	readonly spend: Spend;
}) {
	const judge = yield* Judge;
	const system = kind === "system";
	const call = askingOf(system, spend, thresholds[judge.name]);

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
