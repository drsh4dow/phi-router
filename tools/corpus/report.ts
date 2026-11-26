import { Array, Number as Num, Option, Struct, pipe } from "effect";
import { Carrier, Entry, Identifier, Negative, Transform } from "./manifest.ts";
import type { Case, PhiCase, PhiStrata } from "./manifest.ts";
import type { Seen } from "./seen.ts";
import type { Tracked } from "./canary-tokens.ts";
import type { Usage } from "#router/client/judge/index.ts";
import { seenOn } from "./seen.ts";

interface Sent {
	readonly usage: typeof Usage.Type;
	readonly sealedByJudgeFailure: number;
	readonly openAccountBody: string;
	readonly sealing: boolean;
}

interface Played {
	readonly case: Case;
	readonly sent: readonly Sent[];
	readonly tracked: Tracked;
}

const alpha = 0.05;

const maxRate = 1;

const noFragments = 0;

const half = 0.5;

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
	readonly firstShownIn: number;
}

interface Report {
	readonly strata: readonly {
		readonly axis: keyof PhiStrata;
		readonly value: string;
		readonly cases: number;
		readonly leaks: number;
		readonly leakRateUpper95: number;
	}[];
	readonly leaks: readonly CaseAt[];
	readonly splits: readonly CaseAt[];
	readonly overRouting: readonly {
		readonly negative: typeof Negative.Type;
		readonly cases: number;
		readonly overRouted: number;
		readonly requests: number;
		readonly onSealed: number;
	}[];
	readonly fragments: { readonly cases: number; readonly shown: number };
	readonly requests: { readonly clean: number; readonly sealing: number };
	readonly judge: typeof Usage.Type & { readonly failures: number };
}

type PhiPlayed = Played & { readonly case: typeof PhiCase.Type };

const isPhi = (played: Played): played is PhiPlayed => played.case.expect === "phi";

const seenOf = ({ sent, tracked }: Played, upTo: number): Seen => {
	const open = pipe(
		sent,
		Array.take(upTo),
		Array.map((each) => each.openAccountBody),
	);

	return seenOn({ baa: [], open, tracked });
};

const firstAt = (played: Played, shown: (seen: Seen) => boolean): Option.Option<number> =>
	pipe(
		played.sent,
		Array.findFirstIndex((_sent, index) => shown(seenOf(played, Num.increment(index)))),
		Option.map(Num.increment),
	);

interface Shown {
	readonly played: PhiPlayed;
	readonly leak: readonly CaseAt[];
	readonly split: readonly CaseAt[];
}

const shownOf = (played: PhiPlayed): Shown => {
	const caseAt = (shown: (seen: Seen) => boolean): CaseAt[] =>
		pipe(
			firstAt(played, shown),
			Option.map((firstShownIn) => ({ firstShownIn, id: played.case.id, strata: played.case.strata })),
			Option.toArray,
		);

	const leak = caseAt(({ leaked }) => Array.isReadonlyArrayNonEmpty(leaked));

	if (Array.isReadonlyArrayNonEmpty(leak)) {
		return { leak, played, split: [] };
	}

	return { leak, played, split: caseAt(({ split }) => Array.isReadonlyArrayNonEmpty(split)) };
};

const axes = [
	["identifier", Identifier.literals],
	["carrier", Carrier.literals],
	["transform", Transform.literals],
	["entry", Entry.literals],
] as const;

const strataOf = (scored: readonly Shown[]): Report["strata"] =>
	pipe(
		axes,
		Array.flatMap(([axis, values]) =>
			pipe(
				values,
				Array.map((value) => {
					const inStratum = pipe(
						scored,
						Array.filter(({ played }) => played.case.strata[axis] === value),
					);

					const leaks = pipe(
						inStratum,
						Array.countBy(({ leak }) => Array.isReadonlyArrayNonEmpty(leak)),
					);

					const leakRateUpper95 = missRateUpperBound({ cases: inStratum.length, misses: leaks });

					return { axis, cases: inStratum.length, leakRateUpper95, leaks, value };
				}),
			),
		),
	);

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
						Array.map(({ sent }) => pipe(sent, Array.countBy(Struct.get("sealing")))),
					),
				),
				overRouted: pipe(
					inClass,
					Array.countBy(({ sent }) => pipe(sent, Array.some(Struct.get("sealing")))),
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
		failures: total(({ sealedByJudgeFailure }) => sealedByJudgeFailure),
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
	const phi = pipe(played, Array.filter(isPhi), Array.map(shownOf));
	const sent = pipe(played, Array.flatMap(Struct.get("sent")));

	return {
		fragments: fragmentsOf(played),
		judge: judgeOf(sent),
		leaks: pipe(phi, Array.flatMap(Struct.get("leak"))),
		overRouting: overRoutingOf(
			pipe(
				played,
				Array.filter((each) => each.case.expect === "clean"),
			),
		),
		requests: {
			clean: pipe(
				sent,
				Array.countBy((each) => !each.sealing),
			),
			sealing: pipe(sent, Array.countBy(Struct.get("sealing"))),
		},
		splits: pipe(phi, Array.flatMap(Struct.get("split"))),
		strata: strataOf(phi),
	};
};

export { missRateUpperBound, reportOf };

export type { Played, Report, Sent };
