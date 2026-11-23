import { Array, Effect, pipe } from "effect";
import { Findings, Verdicts, verdictsFor } from "./index.ts";
import { assert, it } from "@effect/vitest";
import { scripted, ssnHit } from "./scripted-judge.ts";
import { Digest } from "effect/crypto";
import { Judge } from "#router/client/judge.ts";
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
