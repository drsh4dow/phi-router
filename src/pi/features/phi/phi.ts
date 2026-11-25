import {
	Array,
	Clock,
	DateTime,
	Duration,
	Effect,
	Option,
	Order,
	Record,
	Ref,
	String as Str,
	Struct,
	flow,
	pipe,
} from "effect";
import type { CommandFailed, Status } from "#shared/cli.ts";
import { SessionId, phiCommand } from "#shared/cli.ts";
import { Router } from "#pi/client/router.ts";
import { piWire } from "#shared/pi.ts";

type Reported = Omit<typeof Status.Type, "session"> & { readonly session: string };

type OpenAccount = Reported["accounts"]["clean"][number];

type Shown = Router | DateTime.CurrentTimeZone;

interface Overflow {
	readonly count: number;
	readonly subscriptions: number;
	readonly back?: number;
}

interface Seen {
	readonly sealed: number;
	readonly overflowed?: number;
	readonly quietUntil?: number;
}

const unrouted = `phi-router: this session's model is not a ${piWire.provider} model, so phi-router does not route it.`;

const statusBarEntry = "phi";

const noLine = Option.getOrUndefined(Option.none<string>());

const none = 0;

const one = 1;

const clockDigits = 2;

const quietWithoutStamp = Duration.toMillis("30 minutes");

const usage = `/${phiCommand.name} ${phiCommand.setup} sets up phi-router, /${phiCommand.name} shows this session's routing. To run the session on the BAA account, switch the model to ${piWire.models.sealed}.`;

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

const twoDigits = (part: number): string => Str.padStart(clockDigits, "0")(String(part));

const clockOf = (at: string | number): Effect.Effect<string, never, DateTime.CurrentTimeZone> =>
	Option.match(DateTime.make(at), {
		onNone: () => Effect.succeed(String(at)),
		onSome: flow(
			DateTime.setZoneCurrent,
			Effect.map(DateTime.toParts),
			Effect.map(({ hour, minute }) => `${twoDigits(hour)}:${twoDigits(minute)}`),
		),
	});

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

const statusLine: Shows = (status) =>
	Array.join(["phi", lastOf(status), `${String(status.sealed)} sealed`, `${String(status.cleared)} cleared`], " · ");

const countOf = (count: number, noun: string): string => {
	if (count === one) {
		return `1 ${noun}`;
	}

	return `${String(count)} ${noun}s`;
};

const sealNotice: (sealed: { readonly newlySealed: number; readonly status: Reported }) => string = (sealed) =>
	`phi-router: ${countOf(sealed.newlySealed, "message")} held patient identifiers and ran only on the BAA account. Last request: ${lastOf(sealed.status)}.`;

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

const overflowAt = (status: Reported, now: number, seen: Seen): readonly [Option.Option<Overflow>, Seen] => {
	const open = openOf(status);
	const back = backOf(open);
	const overflowed = status.overflowed ?? none;
	const count = overflowed - (seen.overflowed ?? none);
	const counts = { overflowed, sealed: status.sealed };

	if (count <= none || now < (seen.quietUntil ?? none)) {
		return [Option.none(), Struct.assign(counts, Struct.pick(seen, ["quietUntil"]))];
	}

	const counted = { count, subscriptions: open.length };

	const overflow: Overflow = Option.match(back, {
		onNone: () => counted,
		onSome: (at) => Struct.assign(counted, { back: at }),
	});

	const quietUntil = Option.getOrElse(back, () => now + quietWithoutStamp);

	return [Option.some(overflow), Struct.assign(counts, { quietUntil })];
};

interface ShownContext {
	readonly hasUI: boolean;
	readonly model: { readonly provider: string } | undefined;
	readonly sessionManager: { readonly getSessionId: () => string };
	readonly ui: {
		readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
		readonly setStatus: (key: string, text: string | undefined) => void;
	};
}

const printedLine: (failed: Pick<CommandFailed, "cause">) => string = (failed) =>
	pipe(
		Str.split(String(failed.cause), "\n"),
		Array.map(Str.trim),
		Array.findFirst(Str.isNonEmpty),
		Option.getOrElse(() => "it printed nothing"),
	);

const failureText: (failed: Pick<CommandFailed, "cause" | "command">) => string = (failed) =>
	`phi-router ${failed.command} failed: ${printedLine(failed)}`;

const sessionOf: (ctx: ShownContext) => typeof SessionId.Type = (ctx) =>
	SessionId.make(ctx.sessionManager.getSessionId());

const routed = (ctx: Pick<ShownContext, "model">): boolean =>
	pipe(
		Option.fromNullishOr(ctx.model),
		Option.exists(({ provider }) => provider === piWire.provider),
	);

const answered: (port: number) => (words: string, ctx: ShownContext) => Effect.Effect<void, never, Shown> =
	(port) => (words, ctx) => {
		if (!routed(ctx)) {
			return Effect.sync(() => {
				ctx.ui.notify(unrouted, "warning");
			});
		}

		if (Str.isNonEmpty(Str.trim(words))) {
			return Effect.sync(() => {
				ctx.ui.notify(usage, "warning");
			});
		}

		return Router.use((client) => client.status(sessionOf(ctx), port)).pipe(
			Effect.flatMap((status) => Effect.map(statusText(status), (text) => ({ status, text }))),
			Effect.match({
				onFailure: (failed) => {
					ctx.ui.notify(failureText(failed), "error");
				},
				onSuccess: ({ status, text }) => {
					ctx.ui.setStatus(statusBarEntry, statusLine(status));
					ctx.ui.notify(text, "info");
				},
			}),
		);
	};

type Observe = (ctx: ShownContext) => Effect.Effect<void, never, Shown>;

const observerOn = Effect.fnUntraced(function* observerOn(port: number) {
	const seen = yield* Ref.make<Readonly<Record<string, Seen>>>({});

	const observe =
		(announce: boolean): Observe =>
		(ctx) =>
			Effect.gen(function* refreshed() {
				if (!routed(ctx)) {
					ctx.ui.setStatus(statusBarEntry, noLine);

					return;
				}

				const session = sessionOf(ctx);
				const status = yield* Router.use((client) => client.status(session, port));
				const now = yield* Clock.currentTimeMillis;
				const seenNow: Seen = { overflowed: status.overflowed ?? none, sealed: status.sealed };
				const firstSeen = { false: seenNow, true: { sealed: none } }[`${announce}`];

				const [before, overflow] = yield* Ref.modify(seen, (all) => {
					const was = Option.getOrElse(Record.get(all, session), () => firstSeen);
					const [told, after] = overflowAt(status, now, was);

					return [[was, told] as const, Record.set(all, session, after)];
				});

				const overflowText = yield* Effect.transposeOption(pipe(overflow, Option.map(overflowNotice)));

				ctx.ui.setStatus(statusBarEntry, statusLine(status));

				if (status.sealed > before.sealed) {
					ctx.ui.notify(sealNotice({ newlySealed: status.sealed - before.sealed, status }), "warning");
				}

				if (Option.isSome(overflowText)) {
					ctx.ui.notify(overflowText.value, "warning");
				}
			}).pipe(
				Effect.catchTag("CommandFailed", (failed) =>
					Effect.sync(() => {
						ctx.ui.setStatus(statusBarEntry, failureText(failed));
					}),
				),
				Effect.when(Effect.succeed(ctx.hasUI)),
				Effect.asVoid,
			);

	return { afterTurn: observe(true), atStart: observe(false) };
});

export { answered, observerOn, printedLine, routed, usage };

export type { Observe, ShownContext };
