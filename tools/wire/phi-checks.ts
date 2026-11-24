import { Array, Effect, String as Str, pipe } from "effect";
import type { Check, Turned } from "./checks.ts";
import { isModelPost, windowsOf } from "./stored.ts";
import type { Sent } from "#router/client/mock-upstreams/index.ts";
import { everyOf } from "./checks.ts";
import { fakes } from "#tools/route/mocked-router.ts";
import { pinnedLine } from "#router/features/lanes/index.ts";
import { stubsFor } from "#router/features/border/index.ts";
import { voidedNumber } from "./cases.ts";

const typed = { pin: "/phi pin", status: "/phi", unpin: "/phi unpin" } as const;

/** The words of the seal notice that name what happened, the same in every harness. */
const sealWords = "held patient identifiers and ran only on the BAA account";

/** What a harness showed of the `/phi` answer and the seal notice in everything a run printed. */
interface Shown {
	readonly pinOn: boolean;
	readonly pinOff: boolean;
	readonly statusBlock: boolean;
	readonly seal: boolean;
	readonly piStatusNamesBaa: boolean;
	/** The RPC mode of pi answered the prompt as handled by an extension command, so it started no run. */
	readonly handled: boolean;
}

/** A run of a harness, with how many pieces the judge mock received during it and what it showed. */
interface PhiTurned extends Turned {
	readonly judged: number;
	readonly shown: Shown;
}

/** The `/phi` turns of a play, each prompt of the same session, by name and in the order it runs them. */
interface PhiTurns<Turn extends PhiTurned = PhiTurned> {
	readonly status: Turn;
	readonly pin: Turn;
	readonly pinned: Turn;
	readonly unpin: Turn;
	readonly unpinned: Turn;
	readonly inOrder: readonly Turn[];
}

const shownIn = (printed: string): Shown => {
	const has = (text: string): boolean => Str.includes(text)(printed);

	return {
		handled: has(`"disposition":"handled"`),
		piStatusNamesBaa: has("phi · baa, model "),
		pinOff: has("Pin: off"),
		pinOn: has("Pin: on"),
		seal: has(sealWords),
		statusBlock: has("Clean lane: open") && has("Sealed lane: baa") && has(" sealed, ") && has("Last request: "),
	};
};

const none = 0;

const sentNothing = (turn: PhiTurned): boolean =>
	turn.judged === none && !pipe([...turn.open, ...turn.baa], Array.some(isModelPost));

const holdsClean =
	(cleanText: string) =>
	(sent: PhiTurned["open"]): boolean =>
		pipe(
			sent,
			Array.some(({ body }) =>
				pipe(
					windowsOf(cleanText),
					Array.some((window) => Str.includes(window)(body)),
				),
			),
		);

const phiChecksOf = (played: { readonly turns: PhiTurns; readonly cleanText: string }): readonly Check[] => {
	const { cleanText, turns } = played;
	const clean = holdsClean(cleanText);

	return [
		{
			name: "no /phi, /phi pin or /phi unpin sends a model request or a judge call",
			ok: pipe([turns.status, turns.pin, turns.unpin], Array.every(sentNothing)),
		},
		{
			name: "after /phi pin, the next clean prompt reaches the BAA mock alone, with no judge call",
			ok: clean(turns.pinned.baa) && !clean(turns.pinned.open) && turns.pinned.judged === none,
		},
		{
			name: "after /phi unpin, the next clean prompt reaches the open mock",
			ok: clean(turns.unpinned.open) && !clean(turns.unpinned.baa),
		},
	];
};

const shownChecksOf = (turns: PhiTurns): readonly Check[] => [
	{
		name: "/phi shows the pin off, the accounts of both lanes, the last request and the counts",
		ok: turns.status.shown.pinOff && turns.status.shown.statusBlock,
	},
	{ name: "/phi pin shows the pin on", ok: turns.pin.shown.pinOn && turns.pin.shown.statusBlock },
	{ name: "/phi unpin shows the pin off", ok: turns.unpin.shown.pinOff && turns.unpin.shown.statusBlock },
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

interface PhiRun<Turn extends PhiTurned, Failure, Needs> {
	readonly command: (prompt: string) => Effect.Effect<Turn, Failure, Needs>;
	readonly prompt: (prompt: string) => Effect.Effect<Turn, Failure, Needs>;
	readonly clean: string;
}

const phiTurns = Effect.fnUntraced(function* phiTurns<Turn extends PhiTurned, Failure, Needs>(
	play: PhiRun<Turn, Failure, Needs>,
) {
	const inOrder = yield* Effect.all(
		[
			play.command(typed.status),
			play.command(typed.pin),
			play.prompt(play.clean),
			play.command(typed.unpin),
			play.prompt(play.clean),
		],
		{ concurrency: 1 },
	);

	const [status, pin, pinned, unpin, unpinned] = inOrder;

	return { inOrder, pin, pinned, status, unpin, unpinned } satisfies PhiTurns<Turn>;
});

/** The prompt whose answer from the open mock starts the pinned subagent. */
const handOff = "Hand the member lookup to the pinned subagent.";

/**
 * The pinned subagent's prompt in the open mock's call, and its answer from the BAA mock, which names the member by the
 * voided number the rules seal.
 */
const subagent = {
	answer: `The member's SSN is ${voidedNumber}. Their internal id is p-17.`,
	prompt: "Find the member's internal id.",
} as const;

const isSubagent = (sent: { readonly body: string }): boolean => Str.includes(pinnedLine)(sent.body);

const naming =
	(model: string): ((sent: Sent) => boolean) =>
	(sent) =>
		Str.includes(`"model":"${model}"`)(sent.body);

const holdsAnswer = ({ body }: Sent): boolean => Str.includes(voidedNumber)(body);

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

export { handOff, isSubagent, phiChecksOf, phiTurns, sealCheckOf, shownChecksOf, shownIn, subagent, subagentChecksOf };

export type { PhiTurned };
