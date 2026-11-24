import { Array, Effect, pipe } from "effect";
import { Findings, Fixtures, Verdicts, verdictsFor } from "./index.ts";
import { assert, it } from "@effect/vitest";
import { scripted, ssnHit } from "./scripted-judge.ts";
import { Digest } from "effect/crypto";
import { Judge } from "#router/client/judge/index.ts";
import type { Message } from "#router/features/parts/index.ts";
import { piecesOf } from "#router/features/parts/index.ts";

const ssnText = "Patient SSN 078-05-1120 on file.";

const internalIdText = "patient_id 4471, asthma, sync failed at step 3";

const messages: readonly Message[] = [
	{ content: [{ text: ssnText, type: "text" }], role: "user" },
	{ content: [{ text: internalIdText, type: "text" }], isError: false, role: "toolResult", toolCallId: "toolu_1" },
];

const clears = 0.1;

const plainRequest = Effect.gen(function* plainRequest() {
	const parts = yield* piecesOf({ messages });

	const pieces = pipe(
		parts,
		Array.map(({ piece }) => piece),
	);

	const keys = pipe(
		pieces,
		Array.map(({ key }) => key),
	);

	const { judge, asked } = scripted({ score: () => clears });
	const expected = [Verdicts.Sealed({ finding: Findings.Rule(ssnHit) }), Verdicts.Cleared({ by: "judge" })];

	const { found } = yield* Effect.provideService(
		verdictsFor(pieces, () => false),
		Judge,
		judge,
	);

	assert.deepStrictEqual(found, Array.zip(keys, expected));

	assert.deepStrictEqual(
		pipe(
			asked,
			Array.map(({ input }) => input.piece),
		),
		[internalIdText],
	);
});

it.layer(Digest.layerWebCrypto)("verdictsFor without a harness", (test) => {
	test.effect(
		"plain messages seal an SSN on its rule and clear an internal id on the judge, asked once",
		() => plainRequest,
	);
});

const chart = "Patient Canary Fakesmith, SSN 078-05-1120";

const question = "why does this fail?";

const fixtureBlock = Effect.gen(function* fixtureBlock() {
	const parts = yield* piecesOf({
		messages: [
			{
				content: [
					{ text: chart, type: "text" },
					{ text: question, type: "text" },
				],
				role: "user",
			},
		],
	});

	const pieces = pipe(
		parts,
		Array.map(({ piece }) => piece),
	);

	const { judge, asked } = scripted({ score: () => clears });

	const judged = Effect.provideService(
		verdictsFor(pieces, () => false),
		Judge,
		judge,
	);

	const { found } = yield* Effect.provideService(judged, Fixtures, [chart]);

	assert.deepStrictEqual(
		pipe(
			found,
			Array.map(([, verdict]) => verdict),
		),
		[Verdicts.Cleared({ by: "judge" })],
	);

	assert.deepStrictEqual(
		pipe(
			asked,
			Array.map(({ input }) => input.piece),
		),
		[question],
	);
});

it.layer(Digest.layerWebCrypto)("verdictsFor with fixtures", (test) => {
	test.effect(
		"a text block that is a registered fixture is skipped, and the message's other block is judged",
		() => fixtureBlock,
	);
});
