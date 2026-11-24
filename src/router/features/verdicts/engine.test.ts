import { Array, Effect, String as Str, Struct, pipe } from "effect";
import { Findings, Fixtures, Verdicts } from "./index.ts";
import type { Question, Script } from "./scripted-judge.ts";
import { Synthetic, thresholds } from "#router/features/policy/index.ts";
import { assert, it } from "@effect/vitest";
import { judgeAll, judgedOne, namedKind, pieceOf, ssnHit } from "./scripted-judge.ts";
import { Base64 } from "effect/encoding";
import { Digest } from "effect/crypto";
import type { IdentifierKind } from "#router/features/policy/index.ts";
import type { Verdict } from "./index.ts";

const clears = 0.1;

const inBand = 0.3;

const sealsAnyPiece = 0.6;

const sealsHigh = 0.9;

const cleared = [Verdicts.Cleared({ by: "judge" })];

const judgeSealed = (kind: IdentifierKind | "unlabelled", score: number): readonly Verdict[] => [
	Verdicts.Sealed({ finding: Findings.Judge({ kind, score }) }),
];

const failureSealed = (why: "judge-error" | "judge-refused" | "too-large"): readonly Verdict[] => [
	Verdicts.Sealed({ finding: Findings.Failure({ why }) }),
];

type Case = readonly [name: string, script: Script, verdicts: readonly Verdict[], questions: readonly Question[]];

const userCases: readonly Case[] = [
	["0.1 clears without a kind call", { score: () => clears }, cleared, ["identifier"]],
	["0.3 with none clears", { kind: () => "none", score: () => inBand }, cleared, ["identifier", "kind"]],
	[
		"0.3 with a named kind seals",
		{ kind: () => namedKind, score: () => inBand },
		judgeSealed(namedKind, inBand),
		["identifier", "kind"],
	],
	[
		"0.6 seals, labelled by the kind call",
		{ kind: () => ssnHit.kind, score: () => sealsAnyPiece },
		judgeSealed(ssnHit.kind, sealsAnyPiece),
		["identifier", "kind"],
	],
	[
		"0.6 with none still seals, unlabelled",
		{ kind: () => "none", score: () => sealsAnyPiece },
		judgeSealed("unlabelled", sealsAnyPiece),
		["identifier", "kind"],
	],
	[
		"0.6 seals unlabelled when the kind call refuses",
		{ kind: () => "refused", score: () => sealsAnyPiece },
		judgeSealed("unlabelled", sealsAnyPiece),
		["identifier", "kind"],
	],
	[
		"a refused kind call in the band seals as a failure",
		{ kind: () => "refused", score: () => inBand },
		failureSealed("judge-refused"),
		["identifier", "kind"],
	],
	[
		"a judge error seals as a failure, asked once",
		{ score: () => "error" },
		failureSealed("judge-error"),
		["identifier"],
	],
];

const failingOnce = (): (() => number | "error") => {
	let failed = false;

	return () => {
		if (failed) {
			return clears;
		}

		failed = true;

		return "error";
	};
};

const systemCases: readonly Case[] = [
	["0.3 clears without a kind call", { kind: () => namedKind, score: () => inBand }, cleared, ["identifier"]],
	["0.6 with none clears", { kind: () => "none", score: () => sealsAnyPiece }, cleared, ["identifier", "kind"]],
	[
		"0.6 with a named kind seals",
		{ kind: () => namedKind, score: () => sealsAnyPiece },
		judgeSealed(namedKind, sealsAnyPiece),
		["identifier", "kind"],
	],
	["a failure is retried once", { score: failingOnce() }, cleared, ["identifier", "identifier"]],
	[
		"a failure on the retry seals",
		{ score: () => "error" },
		failureSealed("judge-error"),
		["identifier", "identifier"],
	],
	[
		"a kind call refused twice seals",
		{ kind: () => "refused", score: () => sealsAnyPiece },
		failureSealed("judge-refused"),
		["identifier", "kind", "kind"],
	],
];

const sealing: Script = { kind: () => namedKind, score: () => sealsHigh };

const ruleSealed = [Verdicts.Sealed({ finding: Findings.Rule(ssnHit) })];

const ruleHit = Effect.gen(function* ruleHit() {
	const piece = yield* pieceOf("Patient SSN 078-05-1120 on file");
	const { questions, verdicts } = yield* judgedOne({ piece, script: sealing });

	assert.deepStrictEqual({ questions, verdicts }, { questions: [], verdicts: ruleSealed });
});

const seamHit = Effect.gen(function* seamHit() {
	const piece = yield* pieceOf("23 on file");
	const seamed = Struct.assign(piece, { seam: "Patient SSN 412-56-78" });
	const { questions, verdicts } = yield* judgedOne({ piece: seamed, script: sealing });

	assert.deepStrictEqual({ questions, verdicts }, { questions: [], verdicts: ruleSealed });
});

const openReply = Effect.gen(function* openReply() {
	const clean = yield* pieceOf("Canary Fakesmith's record is ready.");
	const ssn = yield* pieceOf("Use 078-05-1120 for the test.");
	const rulesOnly = [Verdicts.Cleared({ by: "rules-only" })];

	const cleanJudged = yield* judgedOne({
		piece: Struct.assign(clean, { kind: "reply-open" as const }),
		script: sealing,
	});

	const ssnJudged = yield* judgedOne({ piece: Struct.assign(ssn, { kind: "reply-open" as const }), script: sealing });

	assert.deepStrictEqual(
		{ questions: cleanJudged.questions, verdicts: cleanJudged.verdicts },
		{ questions: [], verdicts: rulesOnly },
	);

	assert.deepStrictEqual(
		{ questions: ssnJudged.questions, verdicts: ssnJudged.verdicts },
		{ questions: [], verdicts: ruleSealed },
	);
});

const sealsOn = (marker: string): Script => ({
	kind: () => namedKind,
	score: ({ piece }) => {
		if (Str.includes(marker)(piece)) {
			return sealsHigh;
		}

		return clears;
	},
});

const judgedPieces = (asked: readonly { readonly input: { readonly piece: string } }[]): string[] =>
	pipe(
		asked,
		Array.map(({ input }) => input.piece),
	);

const syntheticBlanked = Effect.gen(function* syntheticBlanked() {
	const listed = yield* pieceOf("member 078-05-1120 on client STG-0042 failed eligibility");
	const named = yield* pieceOf("078-05-1120 belongs to Canary Fakesmith");
	const judged = judgeAll({ pieces: [listed, named], script: sealsOn("Fakesmith") });
	const identities = { exact: ["078-05-1120"], prefixes: ["STG-"] };
	const { found, asked } = yield* Effect.provideService(judged, Synthetic, identities);

	assert.deepStrictEqual(found, [
		[listed.key, Verdicts.Cleared({ by: "judge" })],
		[named.key, Verdicts.Sealed({ finding: Findings.Judge({ kind: namedKind, score: sealsHigh }) })],
	]);

	assert.include(judgedPieces(asked), "member [synthetic-id] on client [synthetic-id] failed eligibility");
});

const fixtureSkipped = Effect.gen(function* fixtureSkipped() {
	const chart = "Patient Canary Fakesmith, SSN 078-05-1120";
	const alone = yield* pieceOf(chart);
	const question = yield* pieceOf("why does this fail?");
	const beside = Struct.assign(question, { texts: [chart, "why does this fail?"] });
	const judged = judgeAll({ pieces: [alone, beside], script: { score: () => clears } });
	const { found, asked } = yield* Effect.provideService(judged, Fixtures, [chart]);

	assert.deepStrictEqual(found, [
		[alone.key, Verdicts.Cleared({ by: "fixture" })],
		[beside.key, Verdicts.Cleared({ by: "judge" })],
	]);

	assert.deepStrictEqual(judgedPieces(asked), ["why does this fail?"]);
});

it.layer(Digest.layerWebCrypto)("verdictsFor before the judge", (test) => {
	test.effect.each(userCases)("a user message: %s", ([, script, verdicts, questions]) =>
		Effect.gen(function* userMessage() {
			const piece = yield* pieceOf("Follow-up for the import job.");
			const judged = yield* judgedOne({ piece, script });

			assert.deepStrictEqual(
				{ questions: judged.questions, verdicts: judged.verdicts },
				{ questions: [...questions], verdicts: [...verdicts] },
			);
		}),
	);

	test.effect.each(systemCases)("a system part: %s", ([, script, verdicts, questions]) =>
		Effect.gen(function* systemPart() {
			const piece = yield* pieceOf("You are a coding agent.");
			const judged = yield* judgedOne({ piece: Struct.assign(piece, { kind: "system" as const }), script });

			assert.deepStrictEqual(
				{ questions: judged.questions, verdicts: judged.verdicts },
				{ questions: [...questions], verdicts: [...verdicts] },
			);
		}),
	);

	test.effect("a rule hit seals without a judge call", () => ruleHit);
	test.effect("a piece is read after its seam, so an SSN cut across two messages hits the rule", () => seamHit);
	test.effect("an open-account reply is never judged, but a valid SSN in it still seals", () => openReply);
	test.effect(
		"a listed synthetic identity is blanked, and the rest of the piece is still judged",
		() => syntheticBlanked,
	);
	test.effect(
		"a registered fixture part is skipped, and a piece of nothing else clears without the judge",
		() => fixtureSkipped,
	);
});

const { decisions } = thresholds;

const thresholdCases: readonly Case[] = [
	[
		"a score at clearBelow asks the kind question",
		{ kind: () => "none", score: () => decisions.clearBelow },
		cleared,
		["identifier", "kind"],
	],
	[
		"a score at sealAtOrAbove seals whatever the kind call answers",
		{ kind: () => "none", score: () => decisions.sealAtOrAbove },
		judgeSealed("unlabelled", decisions.sealAtOrAbove),
		["identifier", "kind"],
	],
];

it.layer(Digest.layerWebCrypto)("verdictsFor at the judge's thresholds", (test) => {
	test.effect.each(thresholdCases)("a user message: %s", ([, script, verdicts, questions]) =>
		Effect.gen(function* atThreshold() {
			const piece = yield* pieceOf("Follow-up for the import job.");
			const judged = yield* judgedOne({ piece, script });

			assert.deepStrictEqual(
				{ questions: judged.questions, verdicts: judged.verdicts },
				{ questions: [...questions], verdicts: [...verdicts] },
			);
		}),
	);
});

const encodedHit = Effect.gen(function* encodedHit() {
	const piece = yield* pieceOf(`token ${Base64.encode("Patient SSN 078-05-1120 on file")}`);
	const { questions, verdicts } = yield* judgedOne({ piece, script: sealing });

	assert.deepStrictEqual({ questions, verdicts }, { questions: [], verdicts: ruleSealed });
});

it.layer(Digest.layerWebCrypto)("verdictsFor rules on decoded text", (test) => {
	test.effect("an SSN inside base64 text seals on its rule without a judge call", () => encodedHit);
});
