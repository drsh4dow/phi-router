import { Effect, Fiber, Latch, Layer, Struct } from "effect";
import { Findings, Verdicts, verdictsFor } from "#router/features/verdicts/index.ts";
import { assert, it } from "@effect/vitest";
import { mockOn, mockedJudge } from "./configured.ts";
import { Digest } from "effect/crypto";
import { Judge } from "#router/client/judge.ts";
import type { Named } from "./configured.ts";
import { NodeServices } from "@effect/platform-node";
import type { Piece } from "#router/features/policy/index.ts";
import type { Reply } from "#router/client/mock-upstreams.ts";
import { TestClock } from "effect/testing";
import type { Verdict } from "#router/features/verdicts/index.ts";
import { judgeLimits } from "#router/features/policy/index.ts";

const fromEnv: Named = { keyEnv: "PHI_TEST_KEY" };

const trouble = "the piece in trouble";

const fine = "the fine piece";

const onePerPiece = 2;

const clears: Reply = {
	body: { answers: [{ name: "identifier", probability: 0, type: "predicate" }], usage: { input_tokens: 1000 } },
	kind: "body",
};

const pieceOf = (text: string): Piece<string> => ({
	context: [],
	images: [],
	key: text,
	kind: "user",
	seam: "",
	texts: [text],
});

type Asked = ReturnType<typeof verdictsFor<string>>;

const verdictsOf = (judge: Judge["Service"]): Effect.Effect<Effect.Success<Asked>> =>
	Effect.provideService(
		verdictsFor([pieceOf(trouble), pieceOf(fine)], () => false),
		Judge,
		judge,
	);

const sealedAs = (why: "judge-error" | "judge-refused" | "judge-timeout"): readonly (readonly [string, Verdict])[] => [
	[trouble, Verdicts.Sealed({ finding: Findings.Failure({ why }) })],
	[fine, Verdicts.Cleared({ by: "judge" })],
];

const failedCalls = [
	{ name: "an error status", reply: { kind: "status", status: 500 }, totalInputTokens: 1000, why: "judge-error" },
	{
		name: "a refusal",
		reply: {
			body: { answers: [{ name: "identifier", type: "refusal" }], usage: { input_tokens: 700 } },
			kind: "body",
		},
		totalInputTokens: 1700,
		why: "judge-refused",
	},
] as const;

const sealed = Effect.fnUntraced(function* sealed({ reply, why, totalInputTokens }: (typeof failedCalls)[number]) {
	const { judge } = yield* mockedJudge((piece) => {
		if (piece === trouble) {
			return reply;
		}

		return clears;
	}, fromEnv);

	const { found, usage } = yield* verdictsOf(judge);

	assert.deepStrictEqual(found, sealedAs(why));
	assert.deepStrictEqual(Struct.pick(usage, ["calls", "inputTokens"]), { calls: 2, inputTokens: totalInputTokens });
});

const silenceSeals = Effect.gen(function* silenceSeals() {
	const { judge, mock } = yield* mockedJudge((piece) => {
		if (piece === trouble) {
			return { kind: "silence" };
		}

		return clears;
	}, fromEnv);

	const fineAnswered = yield* Latch.make();

	const watched = Judge.of({
		identifier: (...asked) => Effect.ensuring(judge.identifier(...asked), fineAnswered.open),
		kind: judge.kind,
	});

	const running = yield* Effect.forkChild(verdictsOf(watched));

	yield* Effect.andThen(fineAnswered.await, mock.silenced);
	yield* TestClock.adjust(judgeLimits.timeoutMs);

	const { found } = yield* Effect.tap(Fiber.join(running), () => mock.hungUp);
	const received = yield* mock.received;

	assert.deepStrictEqual(found, sealedAs("judge-timeout"));
	assert.lengthOf(received, onePerPiece);
});

const redirectSeals = Effect.gen(function* redirectSeals() {
	const elsewhere = yield* mockOn(() => clears);

	const { judge } = yield* mockedJudge((piece) => {
		if (piece === trouble) {
			return { kind: "redirect", location: `${elsewhere.endpoint}/decisions` };
		}

		return clears;
	}, fromEnv);

	const { found } = yield* verdictsOf(judge);
	const reached = yield* elsewhere.received;

	assert.deepStrictEqual({ found, reached }, { found: sealedAs("judge-error"), reached: [] });
});

/** In the band, so the kind call decides, and a kind answer with no `probabilities` or `confidence`, which Decisions never sends. */
const bareKind: Reply = {
	body: {
		answers: [
			{ name: "identifier", probability: 0.3, type: "predicate" },
			{ choice: "none", name: "kind", type: "choice" },
		],
	},
	kind: "body",
};

const bareKindSeals = Effect.gen(function* bareKindSeals() {
	const { judge } = yield* mockedJudge((piece) => {
		if (piece === trouble) {
			return bareKind;
		}

		return clears;
	}, fromEnv);

	const { found } = yield* verdictsOf(judge);

	assert.deepStrictEqual(found, sealedAs("judge-error"));
});

it.layer(Layer.merge(NodeServices.layer, Digest.layerWebCrypto))("a failed judge call", (test) => {
	test.effect.each(failedCalls)("$name seals only the piece it failed on and counts what it billed", sealed);
	test.effect("no answer within the timeout seals only its piece and hangs up the call", () => silenceSeals);
	test.effect("a redirect seals only its piece and is never followed", () => redirectSeals);
	test.effect("a kind answer missing its probabilities and confidence seals only its piece", () => bareKindSeals);
});
