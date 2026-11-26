import { Array, Number as Num, Option, String as Str, pipe } from "effect";
import type { StepName, Turn } from "./account-turns.ts";
import { answersIn, handBackIn } from "./hand-back.ts";
import { succeeded, verdictOf } from "./checks.ts";
import type { Check } from "./checks.ts";
import type { LaneLogLine } from "#tools/route/mocked-router.ts";
import type { Relayed } from "./relay.ts";
import { costOf } from "./spent.ts";
import { dollars } from "#tools/corpus/render.ts";
import { overdueId } from "./account-turns.ts";
import { voidedSsn } from "./cases.ts";

interface Pinned {
	readonly runs: number;
	readonly rewrites: number;
	readonly gaveUp: number;
}

interface StepRan {
	readonly name: StepName;
	readonly turns: readonly Turn[];
	readonly lines: readonly LaneLogLine[];
	readonly pinned: Pinned;
}

interface Ran {
	readonly steps: readonly StepRan[];
	readonly relayed: readonly Relayed[];
	readonly stateFileTexts: readonly string[];
}

const holdsCanary = Str.includes(voidedSsn);

const printedLines = (step: StepRan): readonly string[] =>
	pipe(
		step.turns,
		Array.flatMap(({ printed }) => Str.split(printed, "\n")),
	);

const answersOf = (step: StepRan): readonly string[] => answersIn(printedLines(step));

const isPinned = ({ lane, reason }: LaneLogLine): boolean => lane === "sealed" && reason === "pinned";

const atLeastOnce = 1;

const exited = (step: StepRan): Check => ({
	name: `${step.name}: every turn exits 0`,
	ok: pipe(
		step.turns,
		Array.every(({ exitCode }) => exitCode === succeeded),
	),
});

const stayedOpen = (step: StepRan): Check => ({
	name: `${step.name}: every request but the pinned subagent's ran on an open account`,
	ok: pipe(
		step.lines,
		Array.filter((line) => !isPinned(line)),
		Array.every(({ lane }) => lane === "clean"),
	),
});

const pinnedRan = (step: StepRan): Check => ({
	name: `${step.name}: the pinned subagent ran on a BAA account`,
	ok: pipe(step.lines, Array.some(isPinned)),
});

const noCanaryIn = (step: StepRan): Check => {
	const answers = answersOf(step);

	return {
		name: `${step.name}: the root agent answered, and no answer of its holds the canary`,
		ok: Array.isReadonlyArrayNonEmpty(answers) && !pipe(answers, Array.some(holdsCanary)),
	};
};

const handedOffChecks = (step: StepRan, own: Check): readonly Check[] => [
	exited(step),
	stayedOpen(step),
	pinnedRan(step),
	own,
	noCanaryIn(step),
];

const toolResultChecks = (step: StepRan): readonly Check[] =>
	handedOffChecks(step, {
		name: `${step.name}: the root agent's answer names ${overdueId}`,
		ok: Array.some(answersOf(step), Str.includes(overdueId)),
	});

const promptLines = 2;

const cleanAt = 0;

const canaryAt = 1;

const stepChecks = {
	prompts: (step: StepRan): readonly Check[] => [
		exited(step),
		{ name: "prompts: the lane log holds two lines", ok: step.lines.length === promptLines },
		{
			name: "prompts: the clean prompt ran on an open account",
			ok: Option.exists(Array.get(step.lines, cleanAt), ({ lane }) => lane === "clean"),
		},
		{
			name: "prompts: the canary prompt stayed on an open account",
			ok: Option.exists(
				Array.get(step.lines, canaryAt),
				({ lane, reason }) => lane === "clean" && reason === "clean",
			),
		},
	],
	"sealed answer": (step: StepRan): readonly Check[] =>
		handedOffChecks(step, {
			name: "sealed answer: the answer check rewrote the pinned subagent's answer at least once",
			ok: step.pinned.rewrites >= atLeastOnce,
		}),
	"sealed answer in auto mode": (step: StepRan): readonly Check[] => [noCanaryIn(step)],
	"tool result": (step: StepRan): readonly Check[] => toolResultChecks(step),
	"tool result through pi-harness": (step: StepRan): readonly Check[] => toolResultChecks(step),
} satisfies Record<StepName, (step: StepRan) => readonly Check[]>;

const answeredStatus = { below: 300, from: 200 } as const;

const free = 0;

const billed = (relayed: Relayed): Option.Option<number> => {
	const answered = relayed.status >= answeredStatus.from && relayed.status < answeredStatus.below;

	if (relayed.lane === "open" || !answered) {
		return Option.some(free);
	}

	if (!relayed.usage.read) {
		return Option.none();
	}

	return costOf({ model: relayed.model, tokens: relayed.usage.tokens });
};

const baaCostOf = (ran: Ran): Option.Option<number> =>
	pipe(ran.relayed, Array.map(billed), Option.all, Option.map(Num.sumAll));

const linesOf = (ran: Ran): readonly LaneLogLine[] =>
	pipe(
		ran.steps,
		Array.flatMap(({ lines }) => lines),
	);

const openOf = (ran: Ran): readonly Relayed[] =>
	pipe(
		ran.relayed,
		Array.filter(({ lane }) => lane === "open"),
	);

const checksOf = (ran: Ran): readonly Check[] => [
	...pipe(
		ran.steps,
		Array.flatMap((step) => stepChecks[step.name](step)),
	),
	{
		name: "the relay carried every request the lane log holds, and some to an open account",
		ok: ran.relayed.length >= linesOf(ran).length && Array.isReadonlyArrayNonEmpty(openOf(ran)),
	},
	{
		name: "no request to an open account held the canary",
		ok: !pipe(
			openOf(ran),
			Array.some(({ holdsCanary: held }) => held),
		),
	},
	{
		name: "no file under the state folder but the sealed store holds the canary",
		ok: !pipe(ran.stateFileTexts, Array.some(holdsCanary)),
	},
	{ name: "tools/wire/spent.ts prices every request a BAA account answered", ok: Option.isSome(baaCostOf(ran)) },
];

const counting = 1;

const lineOf = (line: LaneLogLine, index: number): string =>
	`request ${String(index + counting)}: ${line.lane} lane, account ${line.account}, model ${line.model}, reason ${line.reason}`;

const excerptStart = 0;

const excerptLength = 240;

const excerptOf = (text: string): string => {
	if (holdsCanary(text)) {
		return "a text that holds the canary";
	}

	return `"${Str.slice(excerptStart, excerptLength)(text)}"`;
};

const receivedBy = (step: StepRan): string => {
	if (step.pinned.gaveUp >= atLeastOnce) {
		return "phi-router's withheld reply, the handle of the answer it could not clear";
	}

	return Option.match(handBackIn(printedLines(step)), {
		onNone: () => "nothing: the pinned subagent handed nothing back",
		onSome: ({ fromSubagent, text }) => {
			if (fromSubagent) {
				return `the cleared answer ${excerptOf(text)}`;
			}

			return `the harness's own fallback text ${excerptOf(text)}`;
		},
	});
};

const noteOf = (step: StepRan): string =>
	`${step.name}: the pinned subagent ran ${String(step.pinned.runs)} times, with ${String(step.pinned.rewrites)} rewrites and ${String(step.pinned.gaveUp)} answers withheld; the root agent received ${receivedBy(step)}`;

const reportOf = (report: {
	readonly harness: string;
	readonly ran: Ran;
	readonly checks: readonly Check[];
}): string => {
	const lines = linesOf(report.ran);
	const open = openOf(report.ran).length;

	const judge = Num.sumAll(
		pipe(
			lines,
			Array.map(({ judgeCost }) => judgeCost),
		),
	);

	const baa = Option.match(baaCostOf(report.ran), { onNone: () => "unknown", onSome: dollars });
	const relayedLine = `the relay carried ${String(open)} requests to open accounts and ${String(report.ran.relayed.length - open)} to BAA accounts`;

	return Array.join(
		[
			`accounts ${report.harness}: ${String(lines.length)} lane log lines, ${relayedLine}`,
			...pipe(lines, Array.map(lineOf)),
			...pipe(
				report.ran.steps,
				Array.filter(({ name }) => name !== "prompts"),
				Array.map(noteOf),
			),
			...pipe(report.checks, Array.map(verdictOf)),
			`cost: judge ${dollars(judge)}, BAA tokens ${baa}`,
		],
		"\n",
	);
};

export { checksOf, reportOf };

export type { Ran, StepRan };
