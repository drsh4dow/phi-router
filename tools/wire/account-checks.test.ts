import { Array, Effect, Option, Struct } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { billed, checksOf, reportOf } from "./account-checks.ts";
import type { LaneLogLine } from "#tools/route/mocked-router.ts";
import type { Ran } from "./account-checks.ts";
import type { Turn } from "./account-turns.ts";
import { voidedSsn } from "./cases.ts";

const failedExit = 1;

const noTokens = { cacheRead: 0, cacheWrite: 0, output: 0, uncachedInput: 0 };

const turn: Turn = { exitCode: 0, reportedTokens: noTokens };

const cleanLine: LaneLogLine = {
	account: "claude-setup-token",
	judgeCost: 0.0002,
	judgeFailures: 0,
	lane: "clean",
	model: "claude-haiku-5-5",
	reason: "clean",
	session: "29292929-2929-4929-8929-292929292929",
	substitute: false,
	time: "2026-01-01T00:00:00.000Z",
};

const sealedLine: LaneLogLine = {
	account: "anthropic-baa",
	judgeCost: 0.0001,
	judgeFailures: 0,
	lane: "sealed",
	model: "claude-haiku-5-5",
	reason: "overflow",
	session: "29292929-2929-4929-8929-292929292929",
	substitute: false,
	time: "2026-01-01T00:00:01.000Z",
};

const pinnedLine: LaneLogLine = Struct.assign(sealedLine, { reason: "pinned" as const });

const failedTurn: Turn = Struct.assign(turn, { exitCode: failedExit });

const session: Ran = { lines: [cleanLine, cleanLine], stateFileTexts: ["{}"], turns: [turn, turn] };

const holds = (ran: Ran): boolean => Array.every(checksOf(ran), ({ ok }) => ok);

const checked = Effect.sync(() => {
	assert.deepStrictEqual(
		Array.map(
			[
				session,
				Struct.assign(session, { turns: [turn, failedTurn] }),
				Struct.assign(session, { lines: [cleanLine, cleanLine, cleanLine] }),
				Struct.assign(session, { lines: [sealedLine, cleanLine] }),
				Struct.assign(session, { lines: [cleanLine, sealedLine] }),
				Struct.assign(session, { lines: [cleanLine, pinnedLine] }),
				Struct.assign(session, { stateFileTexts: ["{}", `{"note":"SSN ${voidedSsn}"}`] }),
			],
			holds,
		),
		[true, false, false, false, false, false, false],
	);
});

const unpriced = "claude-unpriced";

const openAccountCost = 0;

const millionUncachedInputOnHaiku = 0.1;

const priced = Effect.sync(() => {
	const spent = Struct.assign(turn, { reportedTokens: Struct.assign(noTokens, { uncachedInput: 1_000_000 }) });

	assert.deepStrictEqual(
		[
			billed([Struct.assign(cleanLine, { model: unpriced }), spent]),
			billed([sealedLine, spent]),
			billed([Struct.assign(sealedLine, { model: unpriced }), spent]),
		],
		[Option.some(openAccountCost), Option.some(millionUncachedInputOnHaiku), Option.none()],
	);
});

const printed = Effect.sync(() => {
	const checks = [
		{ name: "every turn exits 0", ok: true },
		{ name: "the lane log holds two lines", ok: false },
	];

	assert.strictEqual(
		reportOf({
			baa: "$0.1000",
			checks,
			harness: "claude",
			ran: Struct.assign(session, { lines: [cleanLine, sealedLine] }),
		}),
		Array.join(
			[
				"accounts claude: 2 lane log lines",
				"request 1: clean lane, account claude-setup-token, model claude-haiku-5-5, reason clean",
				"request 2: sealed lane, account anthropic-baa, model claude-haiku-5-5, reason overflow",
				"pass every turn exits 0",
				"FAIL the lane log holds two lines",
				"cost: judge $0.0003, BAA tokens $0.1000",
			],
			"\n",
		),
	);
});

describe("an accounts run's session", () => {
	it.effect(
		"fails when a turn exits non-zero, the lane log holds other than two lines, or either prompt ran on a BAA account, or a state file holds the canary",
		() => checked,
	);
	it.effect(
		"costs nothing on an open account, the model's price on a BAA account, and nothing known on a BAA model with no price",
		() => priced,
	);
	it.effect(
		"prints its lane log lines, then each check's verdict, then the judge's and the BAA accounts' cost",
		() => printed,
	);
});
