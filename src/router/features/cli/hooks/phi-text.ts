import { Array, DateTime, Effect, Option, Order, String as Str, flow, pipe } from "effect";
import type { Status } from "#shared/cli.ts";
import type { VersionWait } from "#router/features/cli/newer-plugin.ts";
import { localTimeOf } from "#router/features/cli/accounts/index.ts";
import { phiCommand } from "#shared/cli.ts";
import { pinnedModel } from "#router/features/lanes/index.ts";
import { rewriteLimit } from "#router/features/policy/index.ts";
import { waitNotice } from "#router/features/cli/newer-plugin.ts";

type Reported = Omit<typeof Status.Type, "session"> & { readonly session: string };

type OpenAccount = Reported["accounts"]["clean"][number];

interface Overflow {
	readonly count: number;
	readonly subscriptions: number;
	readonly back?: number;
}

const none = 0;

const one = 1;

const usage = `/${phiCommand.name} shows this session's routing. To run work on the BAA account, hand it to the phi-sealed subagent or switch the model to ${pinnedModel}.`;

type Shows = (status: Reported) => string;

const ranOn = (last: NonNullable<Reported["last"]>): string => {
	const ran = `${last.account}, model ${last.model}`;

	if (last.substitute) {
		return `${ran}, a substitute for the requested model`;
	}

	return ran;
};

const lastOf: Shows = (status) =>
	pipe(Option.fromNullishOr(status.last), Option.match({ onNone: () => "none yet", onSome: ranOn }));

const clockOf = (at: string | number): Effect.Effect<string, never, DateTime.CurrentTimeZone> =>
	Option.match(DateTime.make(at), { onNone: () => Effect.succeed(String(at)), onSome: localTimeOf });

const listOf = (names: readonly string[]): string =>
	pipe(
		names,
		Array.join(", "),
		Option.liftPredicate(Str.isNonEmpty),
		Option.getOrElse(() => "none"),
	);

const openNameOf = (account: OpenAccount): Effect.Effect<string, never, DateTime.CurrentTimeZone> =>
	Option.match(Option.fromUndefinedOr(account.rateLimitedUntil), {
		onNone: () => Effect.succeed(account.name),
		onSome: flow(
			clockOf,
			Effect.map((clock) => `${account.name} (rate-limited, tried again at ${clock})`),
		),
	});

const countOf = (count: number, noun: string): string => {
	if (count === one) {
		return `1 ${noun}`;
	}

	return `${String(count)} ${noun}s`;
};

const openOf = (status: Reported): readonly OpenAccount[] => {
	const { clean, sealed } = status.accounts;

	const vendor = pipe(
		Option.fromNullishOr(status.last),
		Option.flatMap((last) =>
			pipe(
				[...clean, ...sealed],
				Array.findFirst(({ name }) => name === last.account),
			),
		),
		Option.map((account) => account.vendor),
	);

	const ofVendor = (account: OpenAccount): boolean =>
		Option.match(vendor, { onNone: () => true, onSome: (named) => named === account.vendor });

	return pipe(clean, Array.filter(ofVendor));
};

const millisOf = (account: OpenAccount): Option.Option<number> =>
	pipe(
		Option.fromUndefinedOr(account.rateLimitedUntil),
		Option.flatMap((back) => DateTime.make(back)),
		Option.map(DateTime.toEpochMillis),
	);

const earliest = flow(Array.min(Order.Number), Option.some);

const backOf = (open: readonly OpenAccount[]): Option.Option<number> =>
	pipe(open, Array.map(millisOf), Array.getSomes, Array.match({ onEmpty: Option.none, onNonEmpty: earliest }));

const overflowOf = (status: Reported): Option.Option<Overflow> => {
	const open = openOf(status);

	return pipe(
		Option.fromUndefinedOr(status.overflowed),
		Option.filter((count) => count > none),
		Option.map((count) =>
			Option.match(backOf(open), {
				onNone: () => ({ count, subscriptions: open.length }),
				onSome: (back) => ({ back, count, subscriptions: open.length }),
			}),
		),
	);
};

const subscriptions = {
	false: { limits: "its rate limit", them: "it", yours: "your subscription" },
	true: { limits: "their rate limits", them: "them", yours: "your subscriptions" },
} as const;

const overflowWords = Effect.fnUntraced(function* overflowWords(overflow: Overflow) {
	const { limits, them, yours } = subscriptions[`${overflow.subscriptions > one}`];
	const ran = `${countOf(overflow.count, "request")} ran on your BAA account`;

	const why = yield* Option.match(Option.fromUndefinedOr(overflow.back), {
		onNone: () => Effect.succeed(`${ran} because ${yours} hit a rate limit or did not answer.`),
		onSome: flow(
			clockOf,
			Effect.map((clock) => `${yours} hit ${limits}, so ${ran}. phi-router tries ${them} again at ${clock}.`),
		),
	});

	return `${why} Add another subscription: npx phi-router accounts add`;
});

const overflowNotice = (overflow: Overflow): Effect.Effect<string, never, DateTime.CurrentTimeZone> =>
	Effect.map(overflowWords(overflow), (words) => `phi-router: ${words}`);

const statusText = Effect.fnUntraced(function* statusText(status: Reported, wait?: VersionWait) {
	const clean = yield* Effect.forEach(status.accounts.clean, openNameOf, { concurrency: 1 });

	const sealed = pipe(
		status.accounts.sealed,
		Array.map(({ name }) => name),
	);

	const pinned = pipe(
		Option.fromUndefinedOr(status.pinned),
		Option.map(
			({ gaveUp, rewrites, runs }) =>
				`Pinned subagent: ${countOf(runs, "run")}, ${countOf(rewrites, "rewrite")}, ${countOf(gaveUp, "answer")} withheld`,
		),
		Option.toArray,
	);

	const overflow = yield* Effect.transposeOption(Option.map(overflowOf(status), overflowWords));

	return Array.join(
		[
			`session ${status.session}`,
			`Last request: ${lastOf(status)}`,
			`Messages: ${String(status.sealed)} sealed, ${String(status.cleared)} cleared`,
			...pinned,
			`Clean lane: ${listOf(clean)}`,
			`Sealed lane: ${listOf(sealed)}`,
			...pipe(
				overflow,
				Option.map((words) => `Overflow: ${words}`),
				Option.toArray,
			),
			...pipe(Option.fromUndefinedOr(wait), Option.map(waitNotice), Option.toArray),
		],
		"\n",
	);
});

const columns = 80;

const markOf = flow(
	clockOf,
	Effect.map((clock) => `overflow till ${clock}`),
);

const overflowMark = (
	overflow: Overflow,
	last: Reported["last"],
): Option.Option<Effect.Effect<string, never, DateTime.CurrentTimeZone>> =>
	pipe(
		Option.fromNullishOr(last),
		Option.filter((ran) => ran.overflow === true),
		Option.map(() =>
			Option.match(Option.fromUndefinedOr(overflow.back), {
				onNone: () => Effect.succeed("overflow"),
				onSome: markOf,
			}),
		),
	);

const firstWide = "\u1100";

const punctuation = { first: "\u2000", last: "\u206F" };

const zeroWidth = /\p{Mn}|\p{Me}/u;

const cellsOfChar = (char: string): number => {
	if (zeroWidth.test(char)) {
		return none;
	}

	if (char < firstWide || (char >= punctuation.first && char <= punctuation.last)) {
		return one;
	}

	return one + one;
};

const cellsOf = (text: string): number =>
	Array.reduce(Array.fromIterable(text), none, (sum, char) => sum + cellsOfChar(char));

const cut = (text: string, width: number): string => {
	if (cellsOf(text) <= width) {
		return text;
	}

	let kept = "";

	for (const char of text) {
		if (cellsOf(kept) + cellsOfChar(char) > width - one) {
			break;
		}

		kept += char;
	}

	return `${kept}…`;
};

const statusLine = Effect.fnUntraced(function* statusLine(status: Reported, wait?: VersionWait) {
	const pinned = Option.fromUndefinedOr(status.pinned);

	const runs = pipe(
		pinned,
		Option.filter(({ runs: count }) => count >= one),
		Option.map(({ runs: count }) => countOf(count, "pinned run")),
	);

	const withheld = pipe(
		pinned,
		Option.filter(({ gaveUp }) => gaveUp >= one),
		Option.map(({ gaveUp }) => `${String(gaveUp)} withheld`),
	);

	const overflow = yield* Effect.transposeOption(
		Option.flatMap(overflowOf(status), (counted) => overflowMark(counted, status.last)),
	);

	const pending = pipe(
		Option.fromUndefinedOr(wait),
		Option.map(({ installed }) => `${installed} pending`),
	);

	const account = pipe(
		Option.fromNullishOr(status.last),
		Option.match({ onNone: () => "none yet", onSome: ({ account: name }) => name }),
	);

	const notices = Array.getSomes([withheld, overflow, pending]);
	const counts = [`${String(status.cleared)} cleared`, ...Option.toArray(runs)];

	const row = (name: string, shown: readonly string[]): string =>
		Array.join(["phi", name, `${String(status.sealed)} sealed`, ...shown], " · ");

	const counted = row(account, [...counts, ...notices]);

	if (cellsOf(counted) <= columns) {
		return counted;
	}

	const over = cellsOf(row(account, notices)) - columns;

	const shortened = cut(account, cellsOf(account) - over);

	return cut(row(shortened, notices), columns);
});

const sealNotice: (sealed: { readonly count: number; readonly status: Reported }) => string = (sealed) =>
	`phi-router: ${countOf(sealed.count, "message")} held patient identifiers. The open account sees a handle in place of each. Last request: ${lastOf(sealed.status)}.`;

const withheldWords = {
	false: { answers: "answer", got: "its handle", them: "it" },
	true: { answers: "answers", got: "their handles", them: "them" },
} as const;

const withheldNotice = (count: number): string => {
	const { answers, got, them } = withheldWords[`${count > one}`];

	return `phi-router: ${String(count)} pinned subagent ${answers} still held patient identifiers after ${String(rewriteLimit)} rewrites, so phi-router withheld ${them}, and the agent got ${got} instead.`;
};

export { backOf, openOf, overflowNotice, sealNotice, statusLine, statusText, usage, withheldNotice };

export type { Overflow, Reported };
