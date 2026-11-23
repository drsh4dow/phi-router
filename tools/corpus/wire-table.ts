import { Array, Predicate, pipe } from "effect";
import type { Case } from "./manifest.ts";
import type { Seen } from "./seen.ts";

/** What one corpus case did on the wire. */
interface Outcome extends Seen {
	readonly id: string;
	readonly expect: Case["expect"];
	/** Requests that reached an open account's mock, and those the router sent to the BAA account's mock. */
	readonly open: number;
	readonly baa: number;
	/** Why the harness did not play the case through, when it broke on it. */
	readonly broken?: string;
}

/**
 * A case fails the gate when a complete identifier or a sealed message reached an open account's mock, its PHI did not
 * all reach the BAA account's mock, or the harness broke on it. A fragment, and an identifier split across messages,
 * are reported and pass.
 *
 * @param {Outcome} outcome What the case did on the wire.
 * @returns {boolean} Whether the case fails the gate.
 */
const failed = (outcome: Pick<Outcome, "broken" | "leaked" | "missing" | "unsealed">): boolean =>
	Array.isReadonlyArrayNonEmpty(outcome.leaked) ||
	Array.isReadonlyArrayNonEmpty(outcome.unsealed) ||
	Array.isReadonlyArrayNonEmpty(outcome.missing) ||
	Predicate.isString(outcome.broken);

const none = 0;

const percentScale = 1000;

const tenths = 10;

const shareOf = (part: number, whole: number): number => {
	if (whole === none) {
		return none;
	}

	return Math.round((part / whole) * percentScale) / tenths;
};

const laneOf = ({ open }: Outcome): string => {
	if (open > none) {
		return "open";
	}

	return "BAA only";
};

/** How many clean cases reached an open account's mock, and one report line per clean case, then the share. */
interface CleanReach {
	readonly reached: number;
	readonly lines: readonly string[];
}

/**
 * Each clean case's lane, and how many clean cases reached an open account's mock.
 *
 * @param {readonly Outcome[]} outcomes What each case did on the wire.
 * @returns {CleanReach} The clean cases that reached an open account's mock, and the report.
 */
const cleanReachOf = (outcomes: readonly Outcome[]): CleanReach => {
	const clean = pipe(
		outcomes,
		Array.filter(({ expect }) => expect === "clean"),
	);

	const reached = pipe(
		clean,
		Array.filter(({ open }) => open > none),
	).length;

	const percent = shareOf(reached, clean.length);

	return {
		lines: [
			...pipe(
				clean,
				Array.map((outcome) => `${outcome.id}\t${laneOf(outcome)}`),
			),
			`clean cases on an open account's mock: ${String(reached)} of ${String(clean.length)} (${String(percent)}%)`,
		],
		reached,
	};
};

export { cleanReachOf, failed };
