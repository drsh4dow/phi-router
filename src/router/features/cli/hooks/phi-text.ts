import { Array, Option, String as Str, pipe } from "effect";
import type { Status } from "#shared/cli.ts";
import { phiCommand } from "#shared/cli.ts";
import { pinnedModel } from "#router/features/lanes/index.ts";

type Reported = Omit<typeof Status.Type, "session"> & { readonly session: string };

const oneMessage = 1;

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

const namesOf = (accounts: Reported["accounts"]["clean"]): string =>
	pipe(
		accounts,
		Array.map(({ name }) => name),
		Array.join(", "),
		Option.liftPredicate(Str.isNonEmpty),
		Option.getOrElse(() => "none"),
	);

const statusText: Shows = (status) =>
	Array.join(
		[
			`phi-router, session ${status.session}`,
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

const sealNotice: (sealed: { readonly count: number; readonly status: Reported }) => string = (sealed) =>
	`phi-router: ${messagesIn(sealed.count)} held patient identifiers and ran only on the BAA account. Last request: ${lastOf(sealed.status)}.`;

export { sealNotice, statusText, usage };
