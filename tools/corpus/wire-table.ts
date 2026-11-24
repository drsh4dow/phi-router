import { Array, Predicate, pipe } from "effect";
import type { Case } from "./manifest.ts";
import type { Seen } from "./seen.ts";

interface WireOutcome extends Seen {
	readonly id: string;
	readonly expect: Case["expect"];
	readonly openRequests: number;
	readonly baaRequests: number;
	readonly brokenBecause?: string;
}

const failed = (outcome: Pick<WireOutcome, "brokenBecause" | "leaked" | "missing" | "unstubbed">): boolean =>
	Array.isReadonlyArrayNonEmpty(outcome.leaked) ||
	Array.isReadonlyArrayNonEmpty(outcome.unstubbed) ||
	Array.isReadonlyArrayNonEmpty(outcome.missing) ||
	Predicate.isString(outcome.brokenBecause);

const none = 0;

const percentScale = 1000;

const tenths = 10;

const shareOf = (part: number, whole: number): number => {
	if (whole === none) {
		return none;
	}

	return Math.round((part / whole) * percentScale) / tenths;
};

const laneOf = ({ openRequests }: WireOutcome): string => {
	if (openRequests > none) {
		return "open";
	}

	return "BAA only";
};

interface CleanReach {
	readonly reached: number;
	readonly lines: readonly string[];
}

const cleanReachOf = (outcomes: readonly WireOutcome[]): CleanReach => {
	const clean = pipe(
		outcomes,
		Array.filter(({ expect }) => expect === "clean"),
	);

	const reached = pipe(
		clean,
		Array.filter(({ openRequests }) => openRequests > none),
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
