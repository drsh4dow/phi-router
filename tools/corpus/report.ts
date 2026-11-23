import { Array, Number as Num, Option, Struct, pipe } from "effect";
import { Carrier, Entry, Identifier, Negative, Transform } from "./manifest.ts";
import type { Case, PhiCase, PhiStrata } from "./manifest.ts";
import type { Lane } from "#router/features/lanes/index.ts";
import type { Seen } from "./seen.ts";
import type { Tracked } from "./canary-tokens.ts";
import type { Usage } from "#router/client/judge-failed.ts";
import { seenOn } from "./seen.ts";

interface Decided {
	readonly usage: typeof Usage.Type;
	/** Pieces this request sealed because the judge failed on them. */
	readonly failures: number;
}

/** A request on the clean lane carries the body the open account received. A sealed request shows open accounts nothing. */
type Sent = (Decided & { readonly lane: "clean"; readonly view: string }) | (Decided & { readonly lane: "sealed" });

interface Played {
	readonly case: Case;
	readonly sent: readonly Sent[];
	readonly tracked: Tracked;
}

const alpha = 0.05;

const maxRate = 1;

const noFragments = 0;

const half = 0.5;

/** Bisection steps, far more than the four decimals the report prints need. */
const bisectionSteps = 100;

interface Tally {
	readonly misses: number;
	readonly cases: number;
}

const logTermsOf = ({ misses, cases }: Tally, rate: number): number[] => {
	const logRate = Math.log(rate);
	const logRest = Math.log1p(-rate);
	const terms: number[] = [];
	let logChoose = 0;

	for (let count = 0; count <= misses; count = Num.increment(count)) {
		terms.push(logChoose + count * logRate + (cases - count) * logRest);
		logChoose += Math.log((cases - count) / Num.increment(count));
	}

	return terms;
};

const binomialCdf = (tally: Tally, rate: number): number => {
	const terms = logTermsOf(tally, rate);
	const top = Math.max(...terms);

	return (
		Math.exp(top) *
		pipe(
			terms,
			Array.map((term) => Math.exp(term - top)),
			Num.sumAll,
		)
	);
};

/**
 * The exact one-sided Clopper-Pearson upper bound at 95%: the rate where P(X <= misses; cases, rate) = 0.05.
 *
 * @param {Tally} tally The misses and the cases.
 * @returns {number} The upper bound of the miss rate.
 */
const missRateUpperBound = (tally: Tally): number => {
	if (tally.misses >= tally.cases) {
		return maxRate;
	}

	let low = 0;
	let high = maxRate;

	for (let step = 0; step < bisectionSteps; step = Num.increment(step)) {
		const mid = (low + high) * half;

		if (binomialCdf(tally, mid) > alpha) {
			low = mid;
		} else {
			high = mid;
		}
	}

	return high;
};

interface CaseAt {
	readonly id: string;
	readonly strata: PhiStrata;
	/** The first request that showed it. */
	readonly request: number;
}

interface Report {
	readonly strata: readonly {
		readonly axis: keyof PhiStrata;
		readonly value: string;
		readonly cases: number;
		readonly leaks: number;
		readonly leakRateUpper95: number;
	}[];
	/** Positive cases that showed a complete canary in one message to open accounts. */
	readonly leaks: readonly CaseAt[];
	/** Positive cases that showed open accounts every part of a split canary, only in different messages, and no leak. */
	readonly splits: readonly CaseAt[];
	readonly overRouting: readonly {
		readonly negative: typeof Negative.Type;
		readonly cases: number;
		readonly overRouted: number;
		readonly requests: number;
		readonly onSealed: number;
	}[];
	readonly fragments: { readonly cases: number; readonly shown: number };
	readonly lanes: Readonly<Record<Lane, number>>;
	readonly judge: typeof Usage.Type & { readonly failures: number };
}

type PhiPlayed = Played & { readonly case: typeof PhiCase.Type };

const isPhi = (played: Played): played is PhiPlayed => played.case.expect === "phi";

const seenOf = ({ sent, tracked }: Played, upTo: number): Seen => {
	const open = pipe(
		sent,
		Array.take(upTo),
		Array.flatMap((each) => {
			if (each.lane === "clean") {
				return [each.view];
			}

			return [];
		}),
	);

	return seenOn({ baa: [], open, tracked });
};

/**
 * The number, counting from 1, of the first request by which the open accounts were shown what `shown` looks for.
 *
 * @param {Played} played The case and its requests.
 * @param {Function} shown What the open accounts' bodies must show.
 * @returns {Option.Option<number>} The request's number, or none.
 */
const firstAt = (played: Played, shown: (seen: Seen) => boolean): Option.Option<number> =>
	pipe(
		played.sent,
		Array.findFirstIndex((_sent, index) => shown(seenOf(played, Num.increment(index)))),
		Option.map(Num.increment),
	);

const leakAt = (played: Played): Option.Option<number> =>
	firstAt(played, ({ leaked }) => Array.isReadonlyArrayNonEmpty(leaked));

const leaked = (played: Played): boolean => Option.isSome(leakAt(played));

const splitAt = (played: Played): Option.Option<number> => {
	if (leaked(played)) {
		return Option.none();
	}

	return firstAt(played, ({ split }) => Array.isReadonlyArrayNonEmpty(split));
};

const axes = [
	["identifier", Identifier.literals],
	["carrier", Carrier.literals],
	["transform", Transform.literals],
	["entry", Entry.literals],
] as const;

const strataOf = (scored: readonly PhiPlayed[]): Report["strata"] =>
	pipe(
		axes,
		Array.flatMap(([axis, values]) =>
			pipe(
				values,
				Array.map((value) => {
					const inStratum = pipe(
						scored,
						Array.filter(({ case: { strata } }) => strata[axis] === value),
					);

					const leaks = pipe(inStratum, Array.filter(leaked)).length;
					const leakRateUpper95 = missRateUpperBound({ cases: inStratum.length, misses: leaks });

					return { axis, cases: inStratum.length, leakRateUpper95, leaks, value };
				}),
			),
		),
	);

const isSealed = ({ lane }: Sent): boolean => lane === "sealed";

const overRoutingOf = (clean: readonly Played[]): Report["overRouting"] =>
	pipe(
		Negative.literals,
		Array.map((negative) => {
			const inClass = pipe(
				clean,
				Array.filter(({ case: { strata } }) => "negative" in strata && strata.negative === negative),
			);

			return {
				cases: inClass.length,
				negative,
				onSealed: Num.sumAll(
					pipe(
						inClass,
						Array.map(({ sent }) => pipe(sent, Array.countBy(isSealed))),
					),
				),
				overRouted: pipe(
					inClass,
					Array.countBy(({ sent }) => pipe(sent, Array.some(isSealed))),
				),
				requests: Num.sumAll(
					pipe(
						inClass,
						Array.map(({ sent }) => sent.length),
					),
				),
			};
		}),
	);

const judgeOf = (sent: readonly Sent[]): Report["judge"] => {
	const total = (of: (each: Sent) => number): number => Num.sumAll(pipe(sent, Array.map(of)));

	return {
		calls: total(({ usage }) => usage.calls),
		cost: total(({ usage }) => usage.cost),
		failures: total(({ failures }) => failures),
		inputTokens: total(({ usage }) => usage.inputTokens),
		ms: total(({ usage }) => usage.ms),
	};
};

const fragmentsOf = (played: readonly Played[]): Report["fragments"] => {
	const shown = pipe(
		played,
		Array.map((each) => seenOf(each, each.sent.length).fragments.length),
	);

	return { cases: pipe(shown, Array.countBy(Num.isGreaterThan(noFragments))), shown: Num.sumAll(shown) };
};

const reportOf = (played: readonly Played[]): Report => {
	const phi = pipe(played, Array.filter(isPhi));
	const sent = pipe(played, Array.flatMap(Struct.get("sent")));

	const casesAt = (at: (each: PhiPlayed) => Option.Option<number>): CaseAt[] =>
		pipe(
			phi,
			Array.flatMap((each) =>
				pipe(
					at(each),
					Option.map((request) => ({ id: each.case.id, request, strata: each.case.strata })),
					Option.toArray,
				),
			),
		);

	return {
		fragments: fragmentsOf(played),
		judge: judgeOf(sent),
		lanes: {
			clean: pipe(
				sent,
				Array.countBy((each) => !isSealed(each)),
			),
			sealed: pipe(sent, Array.countBy(isSealed)),
		},
		leaks: casesAt(leakAt),
		overRouting: overRoutingOf(
			pipe(
				played,
				Array.filter((each) => each.case.expect === "clean"),
			),
		),
		splits: casesAt(splitAt),
		strata: strataOf(phi),
	};
};

export { missRateUpperBound, reportOf };

export type { Played, Report, Sent };
