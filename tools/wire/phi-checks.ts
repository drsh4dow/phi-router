import { Array, Effect, String as Str, pipe } from "effect";
import type { Check, Turned } from "./checks.ts";
import { isModelPost, windowsOf } from "./stored.ts";
import type { Sent } from "#router/client/mock-accounts.ts";
import { fakes } from "#tools/route/mocked-router.ts";
import { pinnedLine } from "#router/features/lanes/index.ts";
import { stubsFor } from "#router/features/border/index.ts";
import { voidedNumber } from "./cases.ts";

/** The `/phi` prompts a play types. */
const typed = { pin: "/phi pin", status: "/phi", unpin: "/phi unpin" } as const;

/** The words of the seal notice that name what happened, the same in every harness. */
const sealWords = "held patient identifiers and ran only on the BAA account";

/** What a harness showed of the `/phi` answer and the seal notice in everything a run printed. */
interface Shown {
	readonly pinOn: boolean;
	readonly pinOff: boolean;
	/** The accounts of both lanes and the message counts. */
	readonly accounts: boolean;
	readonly seal: boolean;
	/** A pi status line that names the BAA account and a model as the last request's. */
	readonly baaLine: boolean;
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

/**
 * What `printed`, everything a harness run printed, shows of the `/phi` answer and the seal notice.
 *
 * @param {string} printed What it printed.
 * @returns {Shown} What it shows.
 */
const shownIn = (printed: string): Shown => {
	const has = (text: string): boolean => Str.includes(text)(printed);

	return {
		accounts: has("Clean lane: open") && has("Sealed lane: baa") && has(" sealed, ") && has("Last request: "),
		baaLine: has("phi · baa, model "),
		handled: has(`"disposition":"handled"`),
		pinOff: has("Pin: off"),
		pinOn: has("Pin: on"),
		seal: has(sealWords),
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

/**
 * The `/phi` checks that read the mocks: no `/phi` command sends a model request
 * or a judge call, a clean prompt after `/phi pin` reaches the BAA mock alone with no judge call, and the next clean
 * prompt after `/phi unpin` reaches the open mock.
 *
 * @param {object} played The `/phi` turns and the clean prompt.
 * @returns {readonly Check[]} The checks.
 */
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

/**
 * The `/phi` checks for a harness that shows the `/phi` answer in what it prints.
 *
 * @param {PhiTurns} turns The `/phi` turns.
 * @returns {readonly Check[]} The checks.
 */
const shownChecksOf = (turns: PhiTurns): readonly Check[] => [
	{
		name: "/phi shows the pin off, the accounts of both lanes, the last request and the counts",
		ok: turns.status.shown.pinOff && turns.status.shown.accounts,
	},
	{ name: "/phi pin shows the pin on", ok: turns.pin.shown.pinOn && turns.pin.shown.accounts },
	{ name: "/phi unpin shows the pin off", ok: turns.unpin.shown.pinOff && turns.unpin.shown.accounts },
];

/**
 * The seal notice check for a harness that shows the seal notice in what it prints.
 *
 * @param {readonly PhiTurned[]} turns Every turn of the play, the one that seals first.
 * @returns {Check} The check.
 */
const sealCheckOf = ([sealing, ...others]: readonly [PhiTurned, ...PhiTurned[]]): Check => ({
	name: "the turn that seals shows the seal notice, and no other turn does",
	ok:
		sealing.shown.seal &&
		!pipe(
			others,
			Array.some((other) => other.shown.seal),
		),
});

/** How a play runs one turn of its session: a `/phi` command, or a prompt. */
interface PhiRun<Turn extends PhiTurned, Failure, Needs> {
	readonly command: (prompt: string) => Effect.Effect<Turn, Failure, Needs>;
	readonly prompt: (prompt: string) => Effect.Effect<Turn, Failure, Needs>;
	/** The clean prompt. */
	readonly clean: string;
}

/** Runs the five `/phi` turns of a play in order: `/phi`, `/phi pin`, the clean prompt, `/phi unpin`, the clean prompt. */
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

/**
 * Whether a request is the pinned subagent's: its instructions, which open with the pinned line, are in its body.
 *
 * @param {object} sent The request.
 * @param {string} sent.body Its body.
 * @returns {boolean} Whether it is.
 */
const isSubagent = (sent: { readonly body: string }): boolean => Str.includes(pinnedLine)(sent.body);

/**
 * Whether a request names `model`.
 *
 * @param {string} model The model.
 * @returns {Function} The test of one request.
 */
const naming =
	(model: string): ((sent: Sent) => boolean) =>
	(sent) =>
		Str.includes(`"model":"${model}"`)(sent.body);

const holdsAnswer = ({ body }: Sent): boolean => Str.includes(voidedNumber)(body);

/**
 * Whether `sent` holds a request and each of them passes `predicate`.
 *
 * @param {readonly Sent[]} sent The requests.
 * @param {Function} predicate The test of one request.
 * @returns {boolean} Whether they all pass.
 */
const allOf = (sent: readonly Sent[], predicate: (one: Sent) => boolean): boolean =>
	Array.isReadonlyArrayNonEmpty(sent) && pipe(sent, Array.every(predicate));

const vendorOf = { claude: "anthropic", codex: "openai" } as const;

/** The harness, and the two turns of a session that hands work to the pinned subagent. */
interface HandedOff {
	readonly harness: "claude" | "codex";
	readonly handedOff: Turned;
	readonly after: Turned;
}

/**
 * What the wire run checks of the pinned subagent: the open mock's answer to the hand-off starts the pinned subagent,
 * which runs on the BAA mock, and the turn after it carries the stub in place of the subagent's answer.
 *
 * @param {HandedOff} played The harness, which names its stub, the hand-off and the turn after it.
 * @returns {readonly Check[]} The checks.
 */
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
			ok: allOf(started, naming(fakes.sealedModel[vendorOf[harness]])),
		},
		{ name: "no request of the pinned subagent reaches the open mock", ok: !pipe(opened, Array.some(isSubagent)) },
		{
			name: "the main session's clean requests keep reaching the open mock under the target model",
			ok: allOf(mainOpen, (sent) => naming(fakes.targetModel)(sent) && !isSubagent(sent)),
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
