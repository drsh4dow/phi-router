import type { Aim, Arrived } from "./send.ts";
import { Array, Option, Struct, pipe } from "effect";
import { current, sealedOnly } from "#router/features/accounts/index.ts";
import type { Routed } from "#router/client/lane-log.ts";
import type { Walk } from "#router/features/accounts/index.ts";
import { modelsAt } from "./send.ts";

type At = ReturnType<typeof current>;

interface Stop {
	readonly at: At;
	readonly fit: boolean;
	readonly resent: boolean;
}

type Spend = "stay" | "fit" | "resend";

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

	if (first.account === latest.account || line.reason === "overflow") {
		return line;
	}

	return Struct.assign(line, { reason: "failover" as const });
};

export { lineOf, stopped, unwalked };

export type { Spend, Stop };
