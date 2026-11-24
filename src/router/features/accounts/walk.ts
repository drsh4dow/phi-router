import type { Account, Accounts } from "#router/client/accounts/index.ts";
import { Array, Hash, Option, Order, pipe } from "effect";

/**
 * The accounts one request may still try, the current one first: the open accounts left, then every BAA account left.
 * It only shrinks, so a request never moves back to the clean lane. `baa` is never empty, so a walk always has a
 * current account.
 */
interface Walk {
	readonly open: readonly Account[];
	readonly baa: Array.NonEmptyReadonlyArray<Account>;
}

/**
 * The index of a session's home account among `count` open accounts: a string hash of the session id, modulo `count`.
 *
 * @param {object} of The session id, and how many open accounts the vendor has.
 * @returns {number} The home account's index.
 */
const homeOf = (of: { readonly session: string; readonly count: number }): number =>
	Math.abs(Hash.string(of.session)) % of.count;

/**
 * Route.tla `Dispatch` and `BaaWalk`: the open accounts from the session's home account on, wrapping, without the
 * stamped ones, then the BAA accounts that carry the request's target model and then those that lack it, each in the
 * file's order. A BAA account is never stamped or skipped.
 *
 * @param {object} at The vendor's accounts, the session id, the open accounts stamped, and the target model.
 * @returns {Walk} The request's walk.
 */
const walkOf = (at: {
	readonly accounts: Accounts;
	readonly session: string;
	readonly stamped: readonly string[];
	readonly model: string;
}): Walk => {
	const { clean, sealed } = at.accounts;
	const [before, fromHome] = Array.splitAt(clean, homeOf({ count: clean.length, session: at.session }));
	const lacking = Order.mapInput(Order.Boolean, (account: Account) => Array.contains(account.lacks, at.model));

	return {
		baa: Array.sort(sealed, lacking),
		open: pipe(
			[...fromHome, ...before],
			Array.filter((account) => !Array.contains(at.stamped, account.name)),
		),
	};
};

/**
 * The walk's current account and its lane.
 *
 * @param {Walk} walk The walk.
 * @returns {object} The account to send to now.
 */
const current = (walk: Walk): { readonly lane: "clean" | "sealed"; readonly account: Account } =>
	Option.match(Array.head(walk.open), {
		onNone: () => ({ account: Array.headNonEmpty(walk.baa), lane: "sealed" as const }),
		onSome: (account) => ({ account, lane: "clean" as const }),
	});

/**
 * The walk of a send that went sealed: its open accounts dropped for good.
 *
 * @param {Walk} walk The walk.
 * @returns {Walk} The BAA accounts alone.
 */
const sealedOnly = (walk: Walk): Walk => ({ baa: walk.baa, open: [] });

/**
 * Route.tla `NextAccount`: the walk without its current account. None past the last BAA account.
 *
 * @param {Walk} walk The walk.
 * @returns {Option.Option<Walk>} The walk from the next account.
 */
const onward = (walk: Walk): Option.Option<Walk> => {
	if (Array.isReadonlyArrayNonEmpty(walk.open)) {
		return Option.some({ baa: walk.baa, open: Array.tailNonEmpty(walk.open) });
	}

	return Array.match(Array.tailNonEmpty(walk.baa), {
		onEmpty: Option.none,
		onNonEmpty: (baa) => Option.some({ baa, open: [] }),
	});
};

export { current, homeOf, onward, sealedOnly, walkOf };

export type { Walk };
