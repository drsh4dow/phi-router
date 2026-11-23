import { Array, Effect, String as Str, Struct } from "effect";
import type { Check } from "./checks.ts";
import type { Sent } from "#router/client/mock-accounts.ts";
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
	received: () => Effect.Effect<readonly [readonly Sent[], readonly Sent[], readonly unknown[]]>,
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

export { during, followUp, withCredentialRule };
