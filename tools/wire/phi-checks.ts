import { Array, Effect, Number, String as Str, pipe } from "effect";
import type { Asked, Said, Sent } from "#router/client/mock-upstreams/index.ts";
import type { Check, Turned } from "./checks.ts";
import { isModelPost, isRefused, overflowing } from "./stored.ts";
import { pinnedLine, pinnedModel } from "#router/features/lanes/index.ts";
import type { LaneLogLine } from "#tools/route/mocked-router.ts";
import { everyOf } from "./checks.ts";
import { fakes } from "#tools/route/mocked-router.ts";
import { stubsFor } from "#router/features/border/index.ts";
import { voidedSsn } from "./cases.ts";

const typed = { status: "/phi", usage: "/phi pin" } as const;

const sealWords = "held patient identifiers and ran only on the BAA account";

interface Shown {
	readonly statusBlock: boolean;
	readonly pinLine: boolean;
	readonly namesSubagent: boolean;
	readonly namesSealedModel: boolean;
	readonly seal: boolean;
	readonly piStatusNamesBaa: boolean;
	readonly handled: boolean;
}

interface PhiTurned extends Turned {
	readonly piecesJudged: number;
	readonly shown: Shown;
}

interface PhiTurns<Turn extends PhiTurned = PhiTurned> {
	readonly status: Turn;
	readonly usage: Turn;
	readonly inOrder: readonly Turn[];
}

const shownIn = (printed: string): Shown => {
	const has = (text: string): boolean => Str.includes(text)(printed);

	return {
		handled: has(`"disposition":"handled"`),
		namesSealedModel: has(`switch the model to ${pinnedModel}`),
		namesSubagent: has("hand it to the phi-sealed subagent"),
		piStatusNamesBaa: has("phi · baa, model "),
		pinLine: has("Pin: "),
		seal: has(sealWords),
		statusBlock: has("Clean lane: open") && has("Sealed lane: baa") && has(" sealed, ") && has("Last request: "),
	};
};

const none = 0;

const sentNothing = (turn: PhiTurned): boolean =>
	turn.piecesJudged === none && !pipe([...turn.open, ...turn.baa], Array.some(isModelPost));

const phiChecksOf = (turns: PhiTurns): readonly Check[] => [
	{
		name: "neither /phi nor /phi pin sends a model request or a judge call",
		ok: pipe(turns.inOrder, Array.every(sentNothing)),
	},
];

const usageCheckOf = (harness: "claude" | "pi", { shown }: PhiTurned): Check => {
	if (harness === "pi") {
		return {
			name: "/phi pin shows the usage, which names the model phi/sealed, and no status",
			ok: shown.namesSealedModel && !shown.statusBlock,
		};
	}

	return {
		name: "/phi pin shows the usage, which names the phi-sealed subagent and the model phi/sealed, and no status",
		ok: shown.namesSubagent && shown.namesSealedModel && !shown.statusBlock,
	};
};

const shownChecksOf = ({
	harness,
	turns,
}: {
	readonly harness: "claude" | "pi";
	readonly turns: PhiTurns;
}): readonly Check[] => [
	{
		name: "/phi shows the accounts of both lanes, the last request and the counts, and no Pin line",
		ok: turns.status.shown.statusBlock && !turns.status.shown.pinLine,
	},
	usageCheckOf(harness, turns.usage),
];

const sealCheckOf = ([sealing, ...others]: readonly [PhiTurned, ...PhiTurned[]]): Check => ({
	name: "the turn that seals shows the seal notice, and no other turn does",
	ok:
		sealing.shown.seal &&
		!pipe(
			others,
			Array.some((other) => other.shown.seal),
		),
});

const phiTurns = Effect.fnUntraced(function* phiTurns<Turn extends PhiTurned, Failure, Needs>(
	command: (prompt: string) => Effect.Effect<Turn, Failure, Needs>,
) {
	const inOrder = yield* Effect.all([command(typed.status), command(typed.usage)], { concurrency: 1 });
	const [status, usage] = inOrder;

	return { inOrder, status, usage } satisfies PhiTurns<Turn>;
});

const handOff = "Hand the member lookup to the pinned subagent.";

const subagent = {
	answer: `The member's SSN is ${voidedSsn}. Their internal id is p-17.`,
	prompt: "Find the member's internal id.",
} as const;

const isSubagent = (sent: { readonly body: string }): boolean => Str.includes(pinnedLine)(sent.body);

const naming =
	(model: string): ((sent: Sent) => boolean) =>
	(sent) =>
		Str.includes(`"model":"${model}"`)(sent.body);

const holdsAnswer = ({ body }: Sent): boolean => Str.includes(voidedSsn)(body);

const vendorOf = { claude: "anthropic", codex: "openai" } as const;

interface HandedOff {
	readonly harness: "claude" | "codex";
	readonly handedOff: Turned;
	readonly after: Turned;
}

const subagentChecksOf = ({ after, handedOff, harness }: HandedOff): readonly Check[] => {
	const started = pipe(handedOff.baa, Array.filter(isSubagent));

	const mainOpen = pipe(
		handedOff.open,
		Array.filter(({ method }) => method === "POST"),
	);

	const opened = [...handedOff.open, ...after.open];

	return [
		{
			name: "the open mock's call starts the pinned subagent, whose requests reach the BAA mock under the sealed model",
			ok: everyOf(started, naming(fakes.sealedModel[vendorOf[harness]])),
		},
		{ name: "no request of the pinned subagent reaches the open mock", ok: !pipe(opened, Array.some(isSubagent)) },
		{
			name: "the main session's clean requests keep reaching the open mock under the target model",
			ok: everyOf(mainOpen, (sent) => naming(fakes.targetModel)(sent) && !isSubagent(sent)),
		},
		{
			name: "the pinned subagent's answer, which holds a canary, reaches the BAA mock in the main session",
			ok: pipe(
				handedOff.baa,
				Array.some((sent) => !isSubagent(sent) && holdsAnswer(sent)),
			),
		},
		{
			name: "the next turn reaches the open mock with the stub in place of the subagent's answer",
			ok:
				pipe(
					after.open,
					Array.some(({ body }) => Str.includes(stubsFor[harness])(body)),
				) && !pipe(opened, Array.some(holdsAnswer)),
		},
	];
};

const insideStamp = "Now list the test steps in one line.";

const overflowPrompts = [overflowing, insideStamp] as const;

const tooManyRequests = 429;

const refusing =
	(script: (asked: Asked) => Said) =>
	(asked: Asked): Said => {
		if (Str.includes(overflowing)(asked.last)) {
			return { body: "{}", kind: "status", status: tooManyRequests };
		}

		return script(asked);
	};

interface OverflowRun<Turn, Failure, Needs> {
	readonly prompt: (prompt: string) => Effect.Effect<Turn, Failure, Needs>;
	readonly command: (prompt: string) => Effect.Effect<Turn, Failure, Needs>;
	readonly status: string;
}

const overflowTurns = Effect.fnUntraced(function* overflowTurns<Turn, Failure, Needs>(
	play: OverflowRun<Turn, Failure, Needs>,
) {
	const inOrder = yield* Effect.all([play.prompt(overflowing), play.prompt(insideStamp), play.command(play.status)], {
		concurrency: 1,
	});

	const [overflowed, quiet, status] = inOrder;

	return { after: [overflowed, quiet] as const, inOrder, status };
});

interface PrintedTurn extends Turned {
	readonly printed: string;
}

interface Overflowed {
	readonly after: readonly [PrintedTurn, ...PrintedTurn[]];
	readonly status: PrintedTurn;
	readonly command: string;
	readonly all: readonly PrintedTurn[];
	readonly lines: readonly LaneLogLine[];
	readonly session: string;
	readonly clock: string;
}

const noticeAt = (clock: string): string =>
	`phi-router: your subscription is rate-limited until ${clock}, so 1 request ran on your BAA account. Add another subscription: npx phi-router accounts add`;

const once = 1;

const timesIn = (printed: string, text: string): number => Str.split(printed, text).length - once;

const noticesIn = (turn: PrintedTurn): number => timesIn(turn.printed, "ran on your BAA account");

const holding =
	(prompt: string) =>
	({ body }: Sent): boolean =>
		Str.includes(prompt)(body);

const isOverflow = (line: LaneLogLine): boolean => line.reason === "overflow";

const overflowChecksOf = (played: Readonly<Overflowed>): readonly Check[] => {
	const [overflowed, ...later] = played.after;

	const [overflowLine, insideLine] = pipe(
		played.lines,
		Array.filter((line) => line.session === played.session),
		Array.takeRight(overflowPrompts.length),
		Array.map(isOverflow),
	);

	const afterOpen = pipe(
		played.after,
		Array.flatMap(({ open }) => open),
		Array.filter(isModelPost),
	);

	const afterBaa = pipe(
		played.after,
		Array.flatMap(({ baa }) => baa),
	);

	return [
		{
			name: "after the open mock answers 429, the clean turn reaches the BAA mock and its lane log line says overflow",
			ok:
				pipe(overflowed.open, Array.some(isRefused)) &&
				pipe(overflowed.baa, Array.some(holding(overflowing))) &&
				overflowLine === true,
		},
		{
			name: "the harness shows the overflow notice once, with the stamp's HH:MM, and no other turn shows one",
			ok:
				timesIn(overflowed.printed, noticeAt(played.clock)) === once &&
				pipe(played.all, Array.map(noticesIn), Number.sumAll) === once,
		},
		{
			name: "the next clean turn, inside the stamp, runs on the BAA mock with an overflow line and shows no notice",
			ok:
				pipe(afterBaa, Array.some(holding(insideStamp))) &&
				pipe(afterOpen, Array.every(isRefused)) &&
				insideLine === true &&
				pipe(later, Array.map(noticesIn), Number.sumAll) < once,
		},
		{
			name: `${played.command} shows the open account rate-limited until the stamp's HH:MM`,
			ok: Str.includes(`Clean lane: open (rate-limited until ${played.clock})`)(played.status.printed),
		},
	];
};

export {
	handOff,
	insideStamp,
	isSubagent,
	overflowChecksOf,
	overflowPrompts,
	overflowTurns,
	phiChecksOf,
	phiTurns,
	refusing,
	sealCheckOf,
	shownChecksOf,
	shownIn,
	subagent,
	subagentChecksOf,
};

export type { PhiTurned };
