import { Array, DateTime, Effect, Option, String as Str, flow, pipe } from "effect";
import type { Status } from "#shared/cli.ts";
import { localTimeOf } from "#router/features/cli/accounts/index.ts";
import { phiCommand } from "#shared/cli.ts";
import { pinnedModel } from "#router/features/lanes/index.ts";

type Reported = Omit<typeof Status.Type, "session"> & { readonly session: string };

type OpenAccount = Reported["accounts"]["clean"][number];

interface Overflow {
	readonly count: number;
	readonly subscriptions: number;
	readonly back?: number;
}

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
			Effect.map((clock) => `${account.name} (rate-limited until ${clock})`),
		),
	});

const statusText = Effect.fnUntraced(function* statusText(status: Reported) {
	const clean = yield* Effect.forEach(status.accounts.clean, openNameOf, { concurrency: 1 });

	const sealed = pipe(
		status.accounts.sealed,
		Array.map(({ name }) => name),
	);

	return Array.join(
		[
			`phi-router, session ${status.session}`,
			`Last request: ${lastOf(status)}`,
			`Messages: ${String(status.sealed)} sealed, ${String(status.cleared)} cleared`,
			`Clean lane: ${listOf(clean)}`,
			`Sealed lane: ${listOf(sealed)}`,
		],
		"\n",
	);
});

const countOf = (count: number, noun: string): string => {
	if (count === one) {
		return `1 ${noun}`;
	}

	return `${String(count)} ${noun}s`;
};

type Counted = Reported & { readonly pinned?: { readonly runs: number } };

const statusLine = (status: Counted): string => {
	const runs = pipe(
		Option.fromUndefinedOr(status.pinned),
		Option.map(({ runs: count }) => countOf(count, "pinned run")),
		Option.toArray,
	);

	return Array.join(
		["phi", lastOf(status), `${String(status.sealed)} sealed`, `${String(status.cleared)} cleared`, ...runs],
		" · ",
	);
};

const sealNotice: (sealed: { readonly count: number; readonly status: Reported }) => string = (sealed) =>
	`phi-router: ${countOf(sealed.count, "message")} held patient identifiers. The open account sees a handle in place of each. Last request: ${lastOf(sealed.status)}.`;

const subscriptions = {
	false: { are: "is", yours: "your subscription" },
	true: { are: "are", yours: "your subscriptions" },
} as const;

const overflowNotice = Effect.fnUntraced(function* overflowNotice(overflow: Overflow) {
	const { are, yours } = subscriptions[`${overflow.subscriptions > one}`];

	const why = yield* Option.match(Option.fromUndefinedOr(overflow.back), {
		onNone: () => Effect.succeed(`${yours} did not answer`),
		onSome: flow(
			clockOf,
			Effect.map((clock) => `${yours} ${are} rate-limited until ${clock}`),
		),
	});

	return `phi-router: ${why}, so ${countOf(overflow.count, "request")} ran on your BAA account. Add another subscription: npx phi-router accounts add`;
});

export { overflowNotice, sealNotice, statusLine, statusText, usage };

export type { OpenAccount, Overflow, Reported };
