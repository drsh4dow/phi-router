import { Array, Effect, Exit, String as Str, Struct, pipe } from "effect";
import { Findings, Verdicts, verdictsFor } from "./index.ts";
import { assert, it } from "@effect/vitest";
import { judgeAll, judgedOne, namedKind, pieceOf } from "./scripted-judge.ts";
import { Digest } from "effect/crypto";
import type { Image } from "#router/features/policy/index.ts";
import { Judge } from "#router/client/judge.ts";
import type { Script } from "./scripted-judge.ts";

const clears = 0.1;

const sealsHigh = 0.9;

const loneImage = 1;

const imagesPerCall = 128;

const imagesInPiece = 129;

const oneCall = 1;

const overSizeLimit = 2_000_001;

const image = (index: number): Image => ({ data: `iVBORw0KGgo${String(index)}`, mimeType: "image/png" });

const sealsLoneImage: Script = {
	kind: () => namedKind,
	score: ({ images }) => {
		if (images.length === loneImage) {
			return sealsHigh;
		}

		return clears;
	},
};

const imagesChunked = Effect.gen(function* imagesChunked() {
	const text = yield* pieceOf("Why is this page blank?");
	const screenshot = Struct.assign(text, { images: pipe(imagesInPiece, Array.makeBy(image)) });
	const { found, asked, usage: spent } = yield* judgeAll({ pieces: [screenshot], script: sealsLoneImage });

	assert.deepStrictEqual(
		pipe(
			asked,
			Array.filter(({ question }) => question === "identifier"),
			Array.map(({ input }) => [input.piece, input.images]),
		),
		[
			["Why is this page blank?", pipe(imagesPerCall, Array.makeBy(image))],
			["Why is this page blank?", [image(imagesPerCall)]],
		],
	);

	assert.deepStrictEqual(found, [
		[screenshot.key, Verdicts.Sealed({ finding: Findings.Judge({ kind: namedKind, score: sealsHigh }) })],
	]);

	assert.deepStrictEqual(spent, { calls: 3, cost: 0.003, inputTokens: 30, ms: 15 });
});

const judgedOnce = Effect.gen(function* judgedOnce() {
	const old = yield* pieceOf("an old message");
	const fresh = yield* pieceOf("a new message");

	const { found, asked } = yield* judgeAll({
		known: (key) => key === old.key,
		pieces: [old, fresh, fresh],
		script: { score: () => clears },
	});

	assert.deepStrictEqual(found, [[fresh.key, Verdicts.Cleared({ by: "judge" })]]);
	assert.lengthOf(asked, oneCall);
});

const failsOnBroken: Script = {
	score: ({ piece }) => {
		if (piece === "the call that breaks") {
			return "error";
		}

		return clears;
	},
};

const errorSealsOne = Effect.gen(function* errorSealsOne() {
	const broken = yield* pieceOf("the call that breaks");
	const fine = yield* pieceOf("the call that works");
	const { found } = yield* judgeAll({ pieces: [broken, fine], script: failsOnBroken });

	assert.deepStrictEqual(found, [
		[broken.key, Verdicts.Sealed({ finding: Findings.Failure({ why: "judge-error" }) })],
		[fine.key, Verdicts.Cleared({ by: "judge" })],
	]);
});

const tooLarge = Effect.gen(function* tooLarge() {
	const huge = yield* pieceOf(Str.repeat(overSizeLimit)("a"));
	const { verdicts, questions } = yield* judgedOne({ piece: huge, script: { score: () => clears } });

	assert.deepStrictEqual(
		{ questions, verdicts },
		{ questions: [], verdicts: [Verdicts.Sealed({ finding: Findings.Failure({ why: "too-large" }) })] },
	);
});

const interrupted = Effect.gen(function* interrupted() {
	const judge = Judge.of({ identifier: () => Effect.interrupt, kind: () => Effect.interrupt });
	const piece = yield* pieceOf("a message");

	const exit = yield* Effect.exit(
		Effect.provideService(
			verdictsFor([piece], () => false),
			Judge,
			judge,
		),
	);

	assert.isTrue(Exit.hasInterrupts(exit));
});

it.layer(Digest.layerWebCrypto)("verdictsFor judge calls", (test) => {
	test.effect("images reach the judge, 128 to a call, and a seal on any call seals the piece", () => imagesChunked);
	test.effect("known keys and repeated keys are judged at most once", () => judgedOnce);
	test.effect("a judge error seals only the piece it failed on", () => errorSealsOne);
	test.effect("a piece over the judge's size limit seals without a call", () => tooLarge);
	test.effect("an interruption propagates instead of becoming a verdict", () => interrupted);
});
