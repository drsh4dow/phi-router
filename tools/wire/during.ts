import { Array, Effect, String as Str, Struct, pipe } from "effect";
import type { Check } from "./checks.ts";
import type { Sent } from "#router/client/mock-accounts.ts";
import { fakes } from "#tools/route/fake-credentials.ts";
import { isClaudeJudgeCall } from "#router/client/mock-upstreams.ts";
import { shownIn } from "./phi-checks.ts";

/** How much of what a harness printed the report keeps. */
const printedTail = 400;

/** The third turn's prompt, the same for every harness. */
const followUp = "Thanks. Now say the same in one short line.";

/**
 * What `run`, one harness run, returns, with the end of what it printed, what it showed of `/phi` and the seal notice,
 * what the open and BAA mocks received while it ran, and how many pieces the judge mock received. `received` reads
 * what the three have received so far.
 */
const during = Effect.fnUntraced(function* during<Ran extends { readonly printed: string }, Failure, Needs>(
	received: () => Effect.Effect<Received>,
	run: () => Effect.Effect<Ran, Failure, Needs>,
) {
	const [openBefore, baaBefore, judgedBefore] = yield* received();
	const ran = yield* run();
	const [open, baa, judged] = yield* received();

	return Struct.assign(ran, {
		baa: Array.drop(baa, baaBefore.length),
		judged: judged.length - judgedBefore.length,
		open: Array.drop(open, openBefore.length),
		printed: Str.slice(-printedTail)(ran.printed),
		shown: shownIn(ran.printed),
	});
});

/**
 * A play's checks, and the credential rule as one more, read once the play is over. `breaches` reads each breach
 * in everything the open, BAA and judge mocks received.
 */
const withCredentialRule = Effect.fnUntraced(function* withCredentialRule(
	checks: readonly Check[],
	breaches: () => Effect.Effect<readonly string[]>,
) {
	const found = yield* breaches();
	const rule = "of the fake credentials, each mock received only its own";

	return [...checks, { name: rule, ok: !Array.isReadonlyArrayNonEmpty(found) }];
});

/** What the open, BAA and judge mocks received, as the run's mocks hand it over. */
type Received = readonly [readonly Sent[], readonly Sent[], readonly unknown[]];

/**
 * What the mocks received, with each Claude judge call on the BAA mock counted as the judge's, so the BAA mock's list
 * holds only model requests.
 *
 * @param {Received} received What the open, BAA and judge mocks received.
 * @returns {Received} The same, the judge calls moved.
 */
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

/**
 * The check that the Claude judge ran on the BAA account: the BAA mock received judge calls, each with its key, and
 * the Decisions mock received none.
 *
 * @param {Received} received What the open, BAA and judge mocks received.
 * @returns {Check} The check.
 */
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
