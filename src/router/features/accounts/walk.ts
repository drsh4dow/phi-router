import type { Account, Accounts } from "#router/client/accounts/index.ts";
import { Array, Hash, Option, Order, pipe } from "effect";

interface Walk {
	readonly open: readonly Account[];
	readonly baa: Array.NonEmptyReadonlyArray<Account>;
}

const homeOf = (of: { readonly session: string; readonly count: number }): number =>
	Math.abs(Hash.string(of.session)) % of.count;

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

const current = (walk: Walk): { readonly lane: "clean" | "sealed"; readonly account: Account } =>
	Option.match(Array.head(walk.open), {
		onNone: () => ({ account: Array.headNonEmpty(walk.baa), lane: "sealed" as const }),
		onSome: (account) => ({ account, lane: "clean" as const }),
	});

const sealedOnly = (walk: Walk): Walk => ({ baa: walk.baa, open: [] });

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
