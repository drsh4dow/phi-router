import {
	Array,
	Config,
	Console,
	Effect,
	FileSystem,
	Number as Num,
	Option,
	Path,
	Schema,
	String as Str,
	pipe,
} from "effect";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import type { LaneLogLine } from "#tools/route/mocked-router.ts";
import type { Turn } from "./account-turns.ts";
import { costOf } from "./spent.ts";
import { laneLines } from "#tools/route/mocked-router.ts";
import { routerProcess } from "#tools/route/router-process.ts";
import { succeeded } from "./checks.ts";
import { turnsOn } from "./account-turns.ts";
import { voidedNumber } from "./cases.ts";

/** `process.argv` holds the runtime and the script before the arguments. */
const runtimeAndScript = 2;

const Harness = Schema.Literals(["claude", "codex", "pi"]);

/** What one session left: its turns, the lane log's lines, and the text of every file in the state folder. */
interface Ran {
	readonly turns: readonly Turn[];
	readonly lines: readonly LaneLogLine[];
	readonly stored: readonly string[];
}

/** The router's environment: a fresh state folder, beside the caller's config folder when the caller names one. */
const routerEnv = Effect.fnUntraced(function* routerEnv() {
	const fs = yield* FileSystem.FileSystem;
	const state = yield* fs.makeTempDirectoryScoped({ prefix: "phi-accounts-state-" });
	const config = yield* Config.option(Config.String("XDG_CONFIG_HOME"));

	return Option.match(config, {
		onNone: () => ({ XDG_STATE_HOME: state }),
		onSome: (folder) => ({ XDG_CONFIG_HOME: folder, XDG_STATE_HOME: state }),
	});
});

/** The text of every file under `folder`. */
const textsUnder = Effect.fnUntraced(function* textsUnder(folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const names = yield* fs.readDirectory(folder, { recursive: true });

	return yield* Effect.forEach(
		names,
		(name) => fs.readFileString(path.join(folder, name)).pipe(Effect.orElseSucceed(() => "")),
		{ concurrency: 1 },
	);
});

/** The router as its own process with a fresh state folder, and one session of `harness` through it. */
const sessionOf = Effect.fnUntraced(function* sessionOf(harness: typeof Harness.Type) {
	const path = yield* Path.Path;
	const env = yield* routerEnv();
	const router = yield* routerProcess(["bun", "src/router/main.ts"], env);
	const turns: readonly Turn[] = yield* turnsOn[harness]({ env, url: router.url });
	const folder = path.join(env.XDG_STATE_HOME, "phi-router");
	const lines = yield* laneLines(folder);
	const stored = yield* textsUnder(folder);

	return { lines, stored, turns } satisfies Ran;
});

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
		ok: !pipe(ran.stored, Array.some(Str.includes(voidedNumber))),
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

	return costOf({ model: line.model, tokens: turn.tokens });
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

/**
 * `bun run wire:accounts <harness>` drives the real harness binary through the router on the real accounts that the
 * caller's `phi-router/config.json` names, in one session: a clean prompt, then a prompt whose canary is a voided SSN.
 * It prints each lane log line, the checks, the judge's cost and the BAA accounts' token cost, and exits non-zero when
 * a check fails or no price is known for the model a BAA account ran. Every account must hold a login folder or a key
 * the router reads, since the harness runs in throwaway folders with a fake login.
 */
const program = Effect.gen(function* program() {
	const [named = ""] = Array.drop(process.argv, runtimeAndScript);

	const harness = yield* Effect.filterOrFail(
		Effect.succeed(named),
		Schema.is(Harness),
		() => `bun run wire:accounts takes one harness, claude, codex or pi. It got "${named}".`,
	);

	const ran = yield* sessionOf(harness);
	const requests = Array.zip(ran.lines, ran.turns);
	const costs = pipe(requests, Array.map(billed));
	const baa = Option.map(Option.all(costs), Num.sumAll);
	const priced = { name: "tools/wire/spent.ts prices every model a BAA account ran", ok: Option.isSome(baa) };
	const checks = Array.append(checksOf(ran), priced);

	yield* Console.log(
		reportOf({ baa: Option.match(baa, { onNone: () => "unknown", onSome: dollars }), checks, harness, ran }),
	);

	return yield* Effect.filterOrFail(
		Effect.succeed(checks),
		Array.every(({ ok }) => ok),
		() => "an accounts check failed",
	);
});

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
