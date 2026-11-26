import { Array, Effect, Number, Predicate, String as Str, pipe } from "effect";
import type { Asked, Said, Sent } from "#router/client/mock-upstreams/index.ts";
import type { Check, Turned } from "./checks.ts";
import { bridgesFor, sealedStub } from "#router/features/border/index.ts";
import { everyOf, holds, stubOf } from "./checks.ts";
import { isModelPost, isRefused, overflowing, tookOf } from "./stored.ts";
import { pinnedLine, pinnedModel } from "#router/features/lanes/index.ts";
import { Handle } from "#router/primitives/handle.ts";
import type { Harness } from "#router/features/border/index.ts";
import type { LaneLogLine } from "#tools/route/mocked-router.ts";
import { fakes } from "#tools/route/mocked-router.ts";
import { voidedSsn } from "./cases.ts";

const typed = { status: "/phi", usage: "/phi pin" } as const;

const sealWords = "held patient identifiers. The open account sees a handle in place of each";

interface Shown {
	readonly statusBlock: boolean;
	readonly pinLine: boolean;
	readonly namesSubagent: boolean;
	readonly namesSealedModel: boolean;
	readonly seal: boolean;
	readonly piStatusSealedOnOpen: boolean;
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
		piStatusSealedOnOpen: has("phi · open, model ") && has(" · 1 sealed · "),
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

const sealCheckOf = (turns: {
	readonly sealing: readonly PhiTurned[];
	readonly others: readonly PhiTurned[];
}): Check => ({
	name: "each turn that seals a new part shows the seal notice, and no other turn does",
	ok:
		everyOf(turns.sealing, ({ shown }) => shown.seal) &&
		!pipe(
			turns.others,
			Array.some(({ shown }) => shown.seal),
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

const mainOpenOf = (handedOff: Turned): readonly Sent[] =>
	pipe(
		handedOff.open,
		Array.filter(({ method }) => method === "POST"),
	);

const subagentChecksOf = ({ after, handedOff, harness }: HandedOff): readonly Check[] => {
	const started = pipe(handedOff.baa, Array.filter(isSubagent));
	const mainOpen = mainOpenOf(handedOff);
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
	];
};

const answerStubChecksOf = ({
	after,
	answer,
	handedOff,
}: HandedOff & { readonly answer: `h${number}` }): readonly Check[] => {
	const stub = stubOf("codex")(answer);
	const mainOpen = mainOpenOf(handedOff);
	const opened = [...handedOff.open, ...after.open];

	return [
		{
			name: `the pinned subagent's answer, which holds a canary, reaches the open mock as the stub of ${answer}, and no request of the main session reaches the BAA mock`,
			ok:
				pipe(
					mainOpen,
					Array.some(({ body }) => Str.includes(stub)(body)),
				) && pipe(handedOff.baa, Array.every(isSubagent)),
		},
		{
			name: "the next turn reaches the open mock with the stub in place of the subagent's answer",
			ok:
				pipe(
					after.open,
					Array.some(({ body }) => Str.includes(stub)(body)),
				) && !pipe(opened, Array.some(holdsAnswer)),
		},
	];
};

interface Handled {
	readonly canaries: readonly string[];
	readonly read: Turned;
	readonly untilCompaction: readonly Turned[];
	readonly handedOff: Turned;
	readonly compacted: Turned;
	readonly reopened: Turned;
	readonly beforeOverflow: readonly Turned[];
	readonly lines: readonly LaneLogLine[];
}

const postsTo =
	(mock: "open" | "baa") =>
	(turn: Turned): readonly Sent[] =>
		pipe(turn[mock], Array.filter(isModelPost));

const isRootLine = ({ reason }: LaneLogLine): boolean => reason === "clean";

const isPinnedLine = ({ reason }: LaneLogLine): boolean => reason === "pinned";

const startedBy = {
	claude: "Agent call starts phi-router:phi-sealed",
	codex: "spawn_agent call starts phi-sealed",
} as const;

const opensFirstHandle =
	(canaries: readonly string[]) =>
	(sent: Sent): boolean =>
		isSubagent(sent) &&
		holds(["[content of h1]", "[end of h1]"])(sent) &&
		holds(["phi-router: you are the pinned subagent."])(sent) &&
		holds(canaries)(sent);

const handleOpenedCheckOf = ({
	canaries,
	handedOff,
	harness,
}: {
	readonly canaries: readonly string[];
	readonly handedOff: Turned;
	readonly harness: keyof typeof startedBy;
}): Check => ({
	name: `AC3: the open mock's ${startedBy[harness]} with a task naming h1, the BAA mock receives it with the canary in place of h1 and the pinned instructions, and the open mock never does`,
	ok:
		pipe(handedOff.baa, Array.some(opensFirstHandle(canaries))) && !pipe(handedOff.open, Array.some(holds(canaries))),
});

const handleChecksOf = (played: Handled): readonly Check[] => {
	const [, ...afterRead] = postsTo("open")(played.read);
	const later = [...afterRead, ...pipe(played.untilCompaction, Array.flatMap(postsTo("open")))];
	const baaBefore = pipe(played.beforeOverflow, Array.flatMap(postsTo("baa")));
	const tookBefore = pipe(played.beforeOverflow, Array.flatMap(tookOf), Array.filter(isModelPost));
	const linesBefore = Array.take(played.lines, tookBefore.length);

	return [
		{
			name: "AC1: after a Read tool result holds the canary, every later root-agent request up to the compaction reaches the open mock with the stub of h2 in its place",
			ok: everyOf(later, (sent) => holds([stubOf("claude")("h2")])(sent) && !holds(played.canaries)(sent)),
		},
		{
			name: "AC1: before the overflow the BAA mock receives only the pinned subagent's requests, and the lane log says clean for every root-agent request",
			ok:
				pipe(baaBefore, Array.every(isSubagent)) &&
				pipe(linesBefore, Array.every(Predicate.or(isRootLine, isPinnedLine))) &&
				Array.countBy(linesBefore, isPinnedLine) === baaBefore.length,
		},
		handleOpenedCheckOf({ canaries: played.canaries, handedOff: played.handedOff, harness: "claude" }),
		{
			name: "AC6: after /compact and a router restart on the same state folder, the pinned subagent's task naming h1 reaches the BAA mock with the canary in place of h1",
			ok:
				Array.isReadonlyArrayNonEmpty(postsTo("open")(played.compacted)) &&
				pipe(played.reopened.baa, Array.some(opensFirstHandle(played.canaries))),
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

interface PrintedTurn extends Turned {
	readonly printed: string;
}

interface Overflowed {
	readonly harness: Harness;
	readonly canaries: readonly string[];
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

const stubbedHandles = /(?<=\[sealed )h[1-9]\d*(?=\])/gu;

const holdsStub =
	(harness: Harness) =>
	({ body }: Sent): boolean =>
		pipe(
			Array.fromIterable(Str.matchAll(stubbedHandles)(body)),
			Array.some(([stubbed]) => Str.includes(sealedStub(harness)(Handle.make(stubbed)))(body)),
		);

const overflowChecksOf = (played: Readonly<Overflowed>): readonly Check[] => {
	const [overflowed, ...later] = played.after;

	const [overflowLine, insideLine] = pipe(
		played.lines,
		Array.filter((line) => line.session === played.session),
		Array.takeRight(overflowPrompts.length),
		Array.map(({ reason }) => reason === "overflow"),
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

	const isRootOverflow = Predicate.and(holding(overflowing), holding(bridgesFor[played.harness]));
	const rootOverflowed = pipe(overflowed.baa, Array.filter(isRootOverflow));

	return [
		{
			name: "AC19: after the open mock answers 429, the root agent's request reaches the BAA mock with each sealed part as a stub with its handle, and never the canary",
			ok: everyOf(rootOverflowed, (sent) => holdsStub(played.harness)(sent) && !holds(played.canaries)(sent)),
		},
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
	answerStubChecksOf,
	handleChecksOf,
	handleOpenedCheckOf,
	handOff,
	insideStamp,
	isSubagent,
	overflowChecksOf,
	overflowPrompts,
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
