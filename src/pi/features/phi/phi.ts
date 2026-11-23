import { Array, Effect, Option, Record, Ref, String as Str, pipe } from "effect";
import type { CommandFailed, Status } from "#shared/cli.ts";
import { SessionId, phiCommand } from "#shared/cli.ts";
import { Router } from "#pi/client/router.ts";

/** What `phi-router status` reports about a session. */
type Reported = Omit<typeof Status.Type, "session"> & { readonly session: string };

/** The provider the pi package adds, whose requests go through the router. */
const routedProvider = "phi";

/** What `/phi` answers when the session's model is another provider's, whose requests never reach the router. */
const unrouted = `phi-router: this session's model is not a ${routedProvider} model, so phi-router does not route it.`;

/** The status bar entry pi shows for the router. */
const statusKey = "phi";

/** The fewest sealed messages, before a session's first seal. */
const noneSealed = 0;

const oneMessage = 1;

/** What `/phi` answers to a word it does not know, and the command's description. */
const usage = `/${phiCommand.name} shows this session's routing, /${phiCommand.name} ${phiCommand.pin} pins it to the sealed lane, /${phiCommand.name} ${phiCommand.unpin} clears the pin.`;

/** A text drawn from what `phi-router status` reported. */
type Shows = (status: Reported) => string;

/**
 * The account and the model of a last request, and that the model was a substitute when it was.
 *
 * @param {object} last The last request.
 * @returns {string} The text.
 */
const ranOn = (last: NonNullable<Reported["last"]>): string => {
	const ran = `${last.account}, model ${last.model}`;

	if (last.substitute) {
		return `${ran}, a substitute for the requested model`;
	}

	return ran;
};

const lastOf: Shows = (status) =>
	pipe(Option.fromNullishOr(status.last), Option.match({ onNone: () => "none yet", onSome: ranOn }));

const namesOf = (accounts: Reported["accounts"]["clean"]): string =>
	pipe(
		accounts,
		Array.map(({ name }) => name),
		Array.join(", "),
		Option.liftPredicate(Str.isNonEmpty),
		Option.getOrElse(() => "none"),
	);

const pinOf: Shows = (status) => {
	if (status.pinned) {
		return "on, every request runs on the sealed lane";
	}

	return "off";
};

/**
 * What `/phi` shows: the session's pin, its last request's account and model, its sealed and cleared counts, and each
 * lane's accounts. The status holds no word of a message, so neither does this.
 *
 * @param {Reported} status What `phi-router status` reported.
 * @returns {string} The lines.
 */
const statusText: Shows = (status) =>
	Array.join(
		[
			`phi-router, session ${status.session}`,
			`Pin: ${pinOf(status)}`,
			`Last request: ${lastOf(status)}`,
			`Messages: ${String(status.sealed)} sealed, ${String(status.cleared)} cleared`,
			`Clean lane: ${namesOf(status.accounts.clean)}`,
			`Sealed lane: ${namesOf(status.accounts.sealed)}`,
		],
		"\n",
	);

/**
 * The status bar's line: the last request's account and model, the counts, and the pin when it is on.
 *
 * @param {Reported} status What `phi-router status` reported.
 * @returns {string} The line.
 */
const statusLine: Shows = (status) =>
	Array.join(
		[
			"phi",
			lastOf(status),
			`${String(status.sealed)} sealed`,
			`${String(status.cleared)} cleared`,
			...Array.filter(["pinned"], () => status.pinned),
		],
		" · ",
	);

const messagesIn = (count: number): string => {
	if (count === oneMessage) {
		return "1 message";
	}

	return `${String(count)} messages`;
};

/**
 * The notice of a turn that sealed messages.
 *
 * @param {object} sealed How many messages the turn sealed, and the status after it.
 * @returns {string} The notice.
 */
const sealNotice: (sealed: { readonly count: number; readonly status: Reported }) => string = (sealed) =>
	`phi-router: ${messagesIn(sealed.count)} held patient identifiers and ran only on the BAA account. Last request: ${lastOf(sealed.status)}.`;

/**
 * What `/phi` and the status bar read of pi's context: the session, its model, whether pi shows a UI, and its notices.
 */
interface ShownContext {
	readonly hasUI: boolean;
	readonly model: { readonly provider: string } | undefined;
	readonly sessionManager: { readonly getSessionId: () => string };
	readonly ui: {
		readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
		readonly setStatus: (key: string, text: string | undefined) => void;
	};
}

/**
 * The first line a `phi-router` command that failed printed, which names why, such as `RouterUnanswered`'s line when no
 * router answers. The stack trace after it is left out.
 *
 * @param {CommandFailed} failed The failure.
 * @returns {string} The text pi shows.
 */
const failureText: (failed: Pick<CommandFailed, "cause" | "command">) => string = (failed) => {
	const why = pipe(
		Str.split(String(failed.cause), "\n"),
		Array.map(Str.trim),
		Array.findFirst(Str.isNonEmpty),
		Option.getOrElse(() => "it printed nothing"),
	);

	return `phi-router ${failed.command} failed: ${why}`;
};

const sessionOf: (ctx: ShownContext) => typeof SessionId.Type = (ctx) =>
	SessionId.make(ctx.sessionManager.getSessionId());

/** The session's status, after pinning or unpinning it when `asked` says so. */
const askedOf = Effect.fnUntraced(function* askedOf(
	asked: "status" | "pin" | "unpin",
	session: typeof SessionId.Type,
	port: number,
) {
	const client = yield* Router;

	if (asked !== "status") {
		yield* client[asked](session, port);
	}

	return yield* client.status(session, port);
});

/**
 * What the words after `/phi` ask, and none for a word it does not know.
 *
 * @param {string} words The words.
 * @returns {Option.Option<"status" | "pin" | "unpin">} What they ask.
 */
const askedBy = (words: string): Option.Option<"status" | "pin" | "unpin"> => {
	const word = Str.trim(words);

	if (Str.isEmpty(word)) {
		return Option.some("status");
	}

	return Option.liftPredicate(word, (said) => said === phiCommand.pin || said === phiCommand.unpin);
};

const routed = (ctx: Pick<ShownContext, "model">): boolean =>
	pipe(
		Option.fromNullishOr(ctx.model),
		Option.exists(({ provider }) => provider === routedProvider),
	);

/**
 * `/phi` for a router on `port`: shows the session's status, after pinning or unpinning it when the words ask, as a
 * notice and in the status bar. A failed command shows as an error that says why. On another provider's model it only
 * says the router does not route the session. It never sends a prompt.
 *
 * @param {number} port The router's port.
 * @returns {Function} The command's handler.
 */
const answered: (port: number) => (words: string, ctx: ShownContext) => Effect.Effect<void, never, Router> =
	(port) => (words, ctx) => {
		if (!routed(ctx)) {
			return Effect.sync(() => {
				ctx.ui.notify(unrouted, "warning");
			});
		}

		return Option.match(askedBy(words), {
			onNone: () =>
				Effect.sync(() => {
					ctx.ui.notify(usage, "warning");
				}),
			onSome: (asked) =>
				askedOf(asked, sessionOf(ctx), port).pipe(
					Effect.match({
						onFailure: (failed) => {
							ctx.ui.notify(failureText(failed), "error");
						},
						onSuccess: (status) => {
							ctx.ui.setStatus(statusKey, statusLine(status));
							ctx.ui.notify(statusText(status), "info");
						},
					}),
				),
		});
	};

/** Shows a session's routing for a context: in the status bar, and in a notice when a turn sealed. */
type Observe = (ctx: ShownContext) => Effect.Effect<void, never, Router>;

/**
 * The status refreshes of a router on `port`, which share the sealed count of each session pi last showed. Each shows
 * the session's last request in the status bar, when pi has a UI, and a router that does not answer there, with why.
 * `afterTurn` also shows a notice when the count grew, counting a session pi has not shown from none. `atStart` only
 * sets the count, so a resumed session does not announce its old seals.
 */
const observerOn = Effect.fnUntraced(function* observerOn(port: number) {
	const seen = yield* Ref.make<Readonly<Record<string, number>>>({});

	const observe =
		(announce: boolean): Observe =>
		(ctx) =>
			Effect.gen(function* refreshed() {
				const session = sessionOf(ctx);
				const status = yield* askedOf("status", session, port);
				const shown = yield* Ref.getAndUpdate(seen, Record.set(session, status.sealed));

				const before = Option.orElse(Record.get(shown, session), () =>
					Option.liftPredicate(noneSealed, () => announce),
				);

				ctx.ui.setStatus(statusKey, statusLine(status));

				if (Option.isSome(before) && status.sealed > before.value) {
					ctx.ui.notify(sealNotice({ count: status.sealed - before.value, status }), "warning");
				}
			}).pipe(
				Effect.catchTag("CommandFailed", (failed) =>
					Effect.sync(() => {
						ctx.ui.setStatus(statusKey, failureText(failed));
					}),
				),
				Effect.when(Effect.succeed(ctx.hasUI)),
				Effect.asVoid,
			);

	return { afterTurn: observe(true), atStart: observe(false) };
});

export { answered, observerOn, routed, routedProvider, usage };

export { phiModels } from "./models.ts";

export type { Observe, ShownContext };
