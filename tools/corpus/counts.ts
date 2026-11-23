import { Array, Record, String as Str, pipe } from "effect";
import type { Random } from "./random.ts";
import type { Sample } from "./conversation.ts";
import { diagnoses } from "./health.ts";
import { prettyJson } from "./encodings.ts";
import { two } from "./record.ts";

const byDiagnosis = (rng: Random): Sample => {
	const fewestRows = 4;
	const mostRows = 7;
	const codeWidth = 8;
	const textWidth = 48;
	const fewestPatients = 3;
	const mostPatients = 900;

	const rows = pipe(
		rng.shuffle(diagnoses),
		Array.take(rng.between(fewestRows, mostRows)),
		Array.map(({ code, text }) =>
			Array.join(
				[
					Str.padEnd(codeWidth)(code),
					Str.padEnd(textWidth)(text.en),
					String(rng.between(fewestPatients, mostPatients)),
				],
				" | ",
			),
		),
	);

	return {
		payload: Array.join(
			[
				"dx_code  | dx_text                                          | patients",
				"---------+--------------------------------------------------+---------",
				...rows,
				`(${String(rows.length)} rows)`,
			],
			"\n",
		),
		scene: {
			asks: ["These totals look low for March. Is the query double-filtering?", "Why is this report missing a row?"],
			commands: [
				`psql -c "select dx_code, dx_text, count(distinct patient_id) as patients from claims where month = '2025-03' group by 1, 2"`,
			],
			paths: ["reports/dx_counts_2025_03.txt"],
		},
	};
};

const monthlyTotals = (rng: Random): Sample => {
	const fewestMonths = 3;
	const mostMonths = 6;

	const lines = Array.makeBy(rng.between(fewestMonths, mostMonths), (index) => {
		const january = 1;
		const fewestClaims = 4000;
		const mostClaims = 15_000;
		const fewestDenied = 100;
		const mostDenied = 900;
		const leastAverageClaimUsd = 90;
		const mostAverageClaimUsd = 240;
		const centDigits = 2;
		const claims = rng.between(fewestClaims, mostClaims);

		return `2025-${two(january + index)},${String(claims)},${String(rng.between(fewestDenied, mostDenied))},${String(claims * rng.between(leastAverageClaimUsd, mostAverageClaimUsd))}.${rng.digits(centDigits)}`;
	});

	return {
		payload: Array.join(["month,claims,denied,paid_total_usd", ...lines], "\n"),
		scene: {
			asks: ["The dashboard and this export disagree on February. Which is right?", "Add a denial rate column."],
			commands: ["cat exports/monthly_totals.csv"],
			paths: ["exports/monthly_totals.csv"],
		},
	};
};

const metrics = (rng: Random): Sample => {
	const fewestMembers = 9000;
	const mostMembers = 40_000;
	const fewestClaims = 100;
	const mostClaims = 900;
	const fewestDenied = 5;
	const mostDenied = 90;
	const rateDigits = 2;
	const fewestPriorAuths = 10;
	const mostPriorAuths = 300;

	return {
		payload: prettyJson(
			Record.fromEntries([
				["activeMembers", rng.between(fewestMembers, mostMembers)],
				["claimsToday", rng.between(fewestClaims, mostClaims)],
				["deniedToday", rng.between(fewestDenied, mostDenied)],
				["denialRate", `0.0${rng.digits(rateDigits)}`],
				["openPriorAuths", rng.between(fewestPriorAuths, mostPriorAuths)],
			]),
		),
		scene: {
			asks: ["Is this metrics payload what the Grafana panel expects?", "Why is the denial rate a string here?"],
			commands: ["curl -s http://localhost:8080/internal/metrics/claims"],
			paths: ["tmp/metrics.json"],
		},
	};
};

const nightlyFile = (rng: Random): string => {
	const firstDay = 1;
	const lastSingleDigitDay = 9;

	return `eligibility_2025030${String(rng.between(firstDay, lastSingleDigitDay))}.csv`;
};

const importSummary = (rng: Random): Sample => {
	const fewestRead = 5000;
	const mostRead = 20_000;
	const fewestRejected = 5;
	const mostRejected = 60;
	const fewestDuplicates = 0;
	const read = rng.between(fewestRead, mostRead);
	const rejected = rng.between(fewestRejected, mostRejected);
	const duplicates = rng.between(fewestDuplicates, rejected);

	return {
		payload: Array.join(
			[
				`import started file=${nightlyFile(rng)}`,
				`import finished rows_read=${String(read)} loaded=${String(read - rejected)} rejected=${String(rejected)}`,
				`rejects: duplicate=${String(duplicates)} schema=${String(rejected - duplicates)}`,
			],
			"\n",
		),
		scene: {
			asks: ["Is a reject count like this normal for the nightly import?", "Where do the schema rejects come from?"],
			commands: ["tail -n 3 logs/import/nightly.log"],
			paths: ["logs/import/nightly.log"],
		},
	};
};

export const counts: Array.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	byDiagnosis,
	monthlyTotals,
	metrics,
	importSummary,
];
