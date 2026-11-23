import { Array, Option, String as Str, pipe } from "effect";
import type { Status } from "#shared/cli.ts";
import { phiCommand } from "#shared/cli.ts";

/** What `phi-router status` reports about a session. */
type Reported = Omit<typeof Status.Type, "session"> & { readonly session: string };

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

export { sealNotice, statusText, usage };
