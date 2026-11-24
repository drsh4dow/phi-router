import { Array, Number as Num, Option, String as Str, pipe } from "effect";
import type { LaneLogLine } from "#tools/route/mocked-router.ts";
import type { Turn } from "./account-turns.ts";
import { costOf } from "./spent.ts";
import { succeeded } from "./checks.ts";
import { voidedSsn } from "./cases.ts";

/** What one session left: its turns, the lane log's lines, and the text of every file in the state folder. */
interface Ran {
	readonly turns: readonly Turn[];
	readonly lines: readonly LaneLogLine[];
	readonly stateFileTexts: readonly string[];
}

const cleanAt = 0;

const canaryAt = 1;

const turnCount = 2;

/**
 * The checks of one session: each turn exits 0, the lane log holds a line per turn, the clean prompt's on the clean
 * lane and the canary prompt's on the sealed lane for its new content, and no stored file holds the canary.
 *
 * @param {Ran} ran What the session left.
 * @returns {readonly object[]} Each check's name and whether it holds.
 */
const checksOf = (ran: Ran): readonly { readonly name: string; readonly ok: boolean }[] => [
	{
		name: "every turn exits 0",
		ok: pipe(
			ran.turns,
			Array.every(({ exitCode }) => exitCode === succeeded),
		),
	},
	{ name: "the lane log holds two lines", ok: ran.lines.length === turnCount },
	{
		name: "the clean prompt ran on an open account",
		ok: Option.exists(Array.get(ran.lines, cleanAt), ({ lane }) => lane === "clean"),
	},
	{
		name: "the canary prompt ran on a BAA account for its sealed new content",
		ok: Option.exists(
			Array.get(ran.lines, canaryAt),
			({ lane, reason }) => lane === "sealed" && reason === "sealed new content",
		),
	},
	{
		name: "no file under the state folder holds the canary",
		ok: !pipe(ran.stateFileTexts, Array.some(Str.includes(voidedSsn))),
	},
];

const free = 0;

/**
 * What one request cost on its BAA account: its turn's tokens at its model's price, and nothing on an open account.
 *
 * @param {readonly [LaneLogLine, Turn]} request The request's lane log line and its turn.
 * @returns {Option.Option<number>} The cost in US dollars, or none when no price is known for the model.
 */
const billed = ([line, turn]: readonly [LaneLogLine, Turn]): Option.Option<number> => {
	if (line.lane === "clean") {
		return Option.some(free);
	}

	return costOf({ model: line.model, tokens: turn.reportedTokens });
};

const costDecimals = 4;

const dollars = (cost: number): string => `$${cost.toFixed(costDecimals)}`;

const counting = 1;

const lineOf = (line: LaneLogLine, index: number): string =>
	`request ${String(index + counting)}: ${line.lane} lane, account ${line.account}, model ${line.model}, reason ${line.reason}`;

const verdictOf = ({ name, ok }: { readonly name: string; readonly ok: boolean }): string => {
	if (ok) {
		return `pass ${name}`;
	}

	return `FAIL ${name}`;
};

/**
 * What the run prints: the lane log's lines, the checks, the judge's cost and the BAA accounts' token cost.
 *
 * @param {object} report The harness, what its session left, the checks and the BAA accounts' cost.
 * @returns {string} The report.
 */
const reportOf = (report: {
	readonly harness: string;
	readonly ran: Ran;
	readonly checks: readonly { readonly name: string; readonly ok: boolean }[];
	readonly baa: string;
}): string => {
	const judge = Num.sumAll(
		pipe(
			report.ran.lines,
			Array.map(({ judgeCost }) => judgeCost),
		),
	);

	const lines = pipe(report.ran.lines, Array.map(lineOf));
	const verdicts = pipe(report.checks, Array.map(verdictOf));
	const header = `accounts ${report.harness}: ${String(report.ran.lines.length)} lane log lines`;
	const cost = `cost: judge ${dollars(judge)}, BAA tokens ${report.baa}`;

	return Array.join([header, ...lines, ...verdicts, cost], "\n");
};

export { billed, checksOf, dollars, reportOf };

export type { Ran };
