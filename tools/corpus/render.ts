import { Array, Number as Num, String as Str, pipe } from "effect";
import type { Report } from "./report.ts";

interface Table {
	readonly header: readonly string[];
	/** How many leading columns are labels, padded on the right. The rest are numbers, padded on the left. */
	readonly labels: number;
	readonly rows: readonly (readonly string[])[];
}

const costDecimals = 4;

const rateDecimals = 4;

const table = ({ header, labels, rows }: Table): string => {
	const widths = pipe(
		header,
		Array.map((title, column) =>
			Math.max(
				title.length,
				...pipe(
					rows,
					Array.map((row) => (row[column] ?? "").length),
				),
			),
		),
	);

	const cellOf = ([cell, width]: readonly [string, number], column: number): string => {
		if (column < labels) {
			return Str.padEnd(width)(cell);
		}

		return Str.padStart(width)(cell);
	};

	const line = (row: readonly string[]): string =>
		Str.trimEnd(pipe(Array.zip(row, widths), Array.map(cellOf), Array.join("  ")));

	return pipe([header, ...rows], Array.map(line), Array.join("\n"));
};

const dollars = (cost: number): string => `$${cost.toFixed(costDecimals)}`;

const inPolicyCases = ({ strata }: Report): number =>
	pipe(
		strata,
		Array.filter(({ axis }) => axis === "identifier"),
		Array.map(({ cases }) => cases),
		Num.sumAll,
	);

const overRouted = ({ overRouting }: Report): Omit<Report["overRouting"][number], "negative"> => ({
	cases: Num.sumAll(
		pipe(
			overRouting,
			Array.map((row) => row.cases),
		),
	),
	onSealed: Num.sumAll(
		pipe(
			overRouting,
			Array.map((row) => row.onSealed),
		),
	),
	overRouted: Num.sumAll(
		pipe(
			overRouting,
			Array.map((row) => row.overRouted),
		),
	),
	requests: Num.sumAll(
		pipe(
			overRouting,
			Array.map((row) => row.requests),
		),
	),
});

const casesTable = (title: string, cases: Report["leaks"]): string => {
	if (Array.isReadonlyArrayEmpty(cases)) {
		return `${title}: none`;
	}

	const rows = pipe(
		cases,
		Array.map(({ id, strata, request }) => [
			id,
			strata.identifier,
			strata.carrier,
			strata.transform,
			strata.entry,
			String(request),
		]),
	);

	return Array.join(
		[title, table({ header: ["case", "identifier", "carrier", "transform", "entry", "request"], labels: 5, rows })],
		"\n",
	);
};

const leakTable = ({ leaks }: Report): string => casesTable("Leaked cases", leaks);

const splitTable = ({ splits }: Report): string =>
	casesTable("Identifiers split across messages, an accepted risk, reported and not gated", splits);

const strataTable = ({ strata }: Report): string =>
	table({
		header: ["axis", "value", "N", "leaks", "upper95"],
		labels: 2,
		rows: pipe(
			strata,
			Array.map((row) => [
				row.axis,
				row.value,
				String(row.cases),
				String(row.leaks),
				row.leakRateUpper95.toFixed(rateDecimals),
			]),
		),
	});

const overRoutingTable = (report: Report): string => {
	const clean = overRouted(report);

	const rows = pipe(
		report.overRouting,
		Array.map((row) => [
			row.negative,
			String(row.cases),
			String(row.overRouted),
			String(row.requests),
			String(row.onSealed),
		]),
	);

	return table({
		header: ["negative", "N", "over-routed", "requests", "sealed"],
		labels: 1,
		rows: [
			...rows,
			["all", String(clean.cases), String(clean.overRouted), String(clean.requests), String(clean.onSealed)],
		],
	});
};

const render = (report: Report): string => {
	const { judge, lanes, fragments } = report;

	return Array.join(
		[
			"In-policy positive cases whose complete canary reached an open account, with the one-sided Clopper-Pearson 95% upper bound",
			strataTable(report),
			"",
			leakTable(report),
			"",
			splitTable(report),
			"",
			"Over-routing: clean cases with any request on the sealed lane, and clean requests on the sealed lane",
			overRoutingTable(report),
			"",
			`in-policy positive cases ${String(inPolicyCases(report))}: leaked ${String(report.leaks.length)}`,
			`fragments: ${String(fragments.cases)} cases showed an open account ${String(fragments.shown)} fragments or split parts, none a leak`,
			`requests: clean lane ${String(lanes.clean)}, sealed lane ${String(lanes.sealed)}`,
			`judge calls ${String(judge.calls)}, input tokens ${String(judge.inputTokens)}, cost ${dollars(judge.cost)}, pieces sealed by a judge failure ${String(judge.failures)}`,
		],
		"\n",
	);
};

export { render as outputOf };
