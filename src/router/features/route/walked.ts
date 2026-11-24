import type { Aim, Arrived } from "./send.ts";
import { Array, Option, Struct, pipe } from "effect";
import { current, sealedOnly } from "#router/features/accounts/index.ts";
import type { Routed } from "#router/client/lane-log.ts";
import type { Walk } from "#router/features/accounts/index.ts";
import { modelsAt } from "./send.ts";

type At = ReturnType<typeof current>;

/**
 * An account the walk stopped at, with what it has spent on this request: its login made fit, and its one 401 resend.
 * Only `stopped` builds one, from `unspent`, when the walk stops at an account it was not at, so every account starts
 * unfit with its resend unspent, whichever path brought the request to it.
 */
interface Stop {
	readonly at: At;
	readonly fit: boolean;
	readonly resent: boolean;
}

/** What an account does at its stop: stays, has its login made fit, or spends its resend on a 401, which unfits it. */
type Spend = "stay" | "fit" | "resend";

/**
 * A request's walk so far, which its one lane log line reads: the account it starts at, each account it stopped at in
 * order, and the model and reason of the latest send built, with whether that model is the substitute. An open account
 * the lane rule moves past is not a stop. The walk never returns to an account it left, so the current account's stop
 * is the last one.
 */
interface Walked {
	readonly start: At;
	readonly stops: readonly Stop[];
	readonly send: Pick<Aim["send"], "model" | "reason" | "substitute">;
}

interface Stopped {
	readonly beforeSpend: Stop;
	readonly afterSpend: Walked;
}

const unspent = { fit: false, resent: false } as const;

const spends = {
	fit: { fit: true },
	resend: { fit: false, resent: true },
	stay: {},
} as const satisfies Record<Spend, Partial<Stop>>;

/**
 * A request's walk before it stops at any account, as when the store could not be read: the account it would start
 * at, the model that account's lane names, and its pin or `router failure`.
 *
 * @param {object} of The request, and its walk as it started.
 * @returns {Walked} No stop yet.
 */
const unwalked = (of: { readonly arrival: Arrived; readonly walk: Walk }): Walked => {
	const { arrival, walk } = of;
	const models = modelsAt(of);

	if (arrival.choice.kind === "pinned") {
		const send = Struct.assign(models.sealed, { reason: arrival.choice.by });

		return { send, start: current(sealedOnly(walk)), stops: [] };
	}

	const start = current(walk);
	const send = Struct.assign(models[start.lane], { reason: "router failure" as const });

	return { send, start, stops: [] };
};

/**
 * Route.tla `Allowance`: the walk once it stays at the aim's account with the aim's send and that account spent
 * `spend`. Its last stop changes when the walk was already there, else a new stop at it is built unspent.
 *
 * @param {object} of The walk so far, the send at its account, and what the account spends.
 * @returns {Stopped} The account's stop before it spent, and the walk after.
 */
const stopped = (of: { readonly walked: Walked; readonly aim: Aim; readonly spend: Spend }): Stopped => {
	const { aim, spend, walked } = of;
	const at = current(aim.walk);
	const here = Option.filter(Array.last(walked.stops), (last) => last.at.account === at.account);
	const before: Stop = Option.getOrElse(here, () => Struct.assign({ at }, unspent));

	const earlier = Option.match(here, {
		onNone: () => walked.stops,
		onSome: () => Option.getOrElse(Array.init(walked.stops), () => []),
	});

	const stop: Stop = Struct.assign(before, Struct.assign({ at }, spends[spend]));

	return {
		afterSpend: { send: aim.send, start: walked.start, stops: Array.append(earlier, stop) },
		beforeSpend: before,
	};
};

/**
 * The request's one lane log line: the last account its walk stopped at, with the reason `failover` once that is
 * another account than its first stop, and the model, whether it is the substitute, and the reason of the latest send
 * built.
 *
 * @param {object} of The request and its walk.
 * @returns {object} The line, but its session.
 */
const lineOf = (of: { readonly arrival: Arrived; readonly walked: Walked }): Omit<Routed, "session"> => {
	const { arrival, walked } = of;

	const ats = pipe(
		walked.stops,
		Array.map((stop) => stop.at),
	);

	const first = Option.getOrElse(Array.head(ats), () => walked.start);
	const latest = Option.getOrElse(Array.last(ats), () => walked.start);

	const line = {
		account: latest.account.name,
		judgeCost: arrival.judged.cost,
		judgeFailures: arrival.judged.failures,
		lane: latest.lane,
		model: walked.send.model,
		reason: walked.send.reason,
		substitute: walked.send.substitute,
	} as const;

	if (first.account === latest.account) {
		return line;
	}

	return Struct.assign(line, { reason: "failover" as const });
};

export { lineOf, stopped, unwalked };

export type { Spend, Stop };
