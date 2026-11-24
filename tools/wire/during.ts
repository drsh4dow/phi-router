import { Array, Effect, String as Str, Struct, pipe } from "effect";
import type { Check } from "./checks.ts";
import type { Sent } from "#router/client/mock-upstreams/index.ts";
import { fakes } from "#tools/route/fake-credentials.ts";
import { isClaudeJudgeCall } from "#router/client/mock-upstreams/index.ts";
import { shownIn } from "./phi-checks.ts";

const printedTail = 400;

const followUp = "Thanks. Now say the same in one short line.";

const during = Effect.fnUntraced(function* during<Ran extends { readonly printed: string }, Failure, Needs>(
	received: () => Effect.Effect<Received>,
	run: () => Effect.Effect<Ran, Failure, Needs>,
) {
	const [openBefore, baaBefore, judgedBefore] = yield* received();
	const ran = yield* run();
	const [open, baa, judged] = yield* received();

	return Struct.assign(ran, {
		baa: Array.drop(baa, baaBefore.length),
		open: Array.drop(open, openBefore.length),
		piecesJudged: judged.length - judgedBefore.length,
		printedTail: Str.slice(-printedTail)(ran.printed),
		shown: shownIn(ran.printed),
	});
});

const withCredentialRule = Effect.fnUntraced(function* withCredentialRule(
	checks: readonly Check[],
	breaches: () => Effect.Effect<readonly string[]>,
) {
	const found = yield* breaches();
	const rule = "of the fake credentials, each mock received only its own";

	return [...checks, { name: rule, ok: !Array.isReadonlyArrayNonEmpty(found) }];
});

type Received = readonly [open: readonly Sent[], baa: readonly Sent[], judged: readonly unknown[]];

const judgeCallsApart = ([open, baa, judged]: Received): Received => [
	open,
	pipe(
		baa,
		Array.filter((sent) => !isClaudeJudgeCall(sent)),
	),
	[
		...pipe(
			baa,
			Array.filter((sent) => isClaudeJudgeCall(sent)),
		),
		...judged,
	],
];

const claudeJudgeCheck = ([, baa, decided]: Received): Check => {
	const calls = pipe(
		baa,
		Array.filter((sent) => isClaudeJudgeCall(sent)),
	);

	return {
		name: "with no judge block, every judge call reaches the BAA mock with its key, and none the Decisions mock",
		ok:
			Array.isReadonlyArrayNonEmpty(calls) &&
			pipe(
				calls,
				Array.every(({ headers }) => headers["x-api-key"] === fakes.baaKey),
			) &&
			!Array.isReadonlyArrayNonEmpty(decided),
	};
};

export { claudeJudgeCheck, during, followUp, judgeCallsApart, withCredentialRule };
