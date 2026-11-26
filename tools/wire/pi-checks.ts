import { Array, Effect, Option, Schema, String as Str, pipe } from "effect";
import type { Check, Played, Run } from "./checks.ts";
import { commonChecksOf, isAsSent, isBaaOnly } from "./checks.ts";
import { fakes, harnesses } from "#tools/route/mocked-router.ts";
import {
	insideStamp,
	overflowChecksOf,
	phiChecksOf,
	phiTurns,
	refusing,
	sealCheckOf,
	shownChecksOf,
} from "./phi-checks.ts";
import { overflowing, tookOf, windowsOf } from "./stored.ts";
import { Base64Url } from "effect/encoding";
import type { PhiTurned } from "./phi-checks.ts";
import type { RpcLine } from "./pi-run.ts";
import type { Sent } from "#router/client/mock-upstreams/index.ts";
import { foundIn } from "#tools/corpus/request-bodies.ts";
import { rpcAnswered } from "./pi-run.ts";
import { handleAt } from "#router/primitives/handle.ts";
import { sealedStub } from "#router/features/border/index.ts";

interface PiTurned extends PhiTurned {
	readonly printed: string;
	readonly pid: number;
	readonly showedLogin: boolean;
	readonly leasedAfterExit: readonly number[];
	readonly routerUpAfterExit: boolean;
}

interface PiPlayed extends Played {
	readonly installed: boolean;
	readonly doctored: boolean;
	readonly leftInTmp: readonly string[];
	readonly routerBefore: boolean;
	readonly routerStopped: boolean;
	readonly verdictStoreFiles: readonly string[];
	readonly clock: string;
	readonly overflow: { readonly after: readonly [PiTurned]; readonly session: string; readonly status: PiTurned };
	readonly turns: readonly [
		clean: PiTurned,
		canary: PiTurned,
		followUp: PiTurned,
		compaction: PiTurned,
		second: PiTurned,
		...phi: PiTurned[],
	];
}

const holdsAny =
	(tokens: readonly string[]) =>
	(sent: readonly Sent[]): boolean =>
		pipe(
			sent,
			Array.map(({ body }) => body),
			(bodies) => foundIn(bodies)(tokens),
			Array.isReadonlyArrayNonEmpty,
		);

const isStoredIn =
	(verdictStoreFiles: readonly string[]) =>
	(session: string): boolean =>
		Array.contains(verdictStoreFiles, `${Base64Url.encode(session)}.json`);

const firstSessionTurns = 4;

const requestsIn = (turns: readonly PiTurned[]): number => pipe(turns, Array.flatMap(tookOf), Array.length);

const sessionsHeld = (played: PiPlayed): boolean => {
	const [first = "", second = ""] = played.sessions;
	const named = (session: string): number => Array.countBy(played.stored.lines, (line) => line.session === session);

	return (
		named(first) === requestsIn(Array.take(played.turns, firstSessionTurns)) &&
		named(second) === requestsIn(Array.drop(played.turns, firstSessionTurns))
	);
};

const wireChecksOf = (played: PiPlayed): readonly Check[] => {
	const [clean, canary, followUp, compaction] = played.turns;

	const baa = pipe(
		played.turns,
		Array.flatMap((turn) => turn.baa),
	);

	const cleanCase = pipe(
		clean.open,
		Array.filter((sent) => holdsAny(windowsOf(played.cleanText))([sent])),
	);

	const compacted = [...compaction.open, ...compaction.baa];

	return [
		{
			name: "the clean case reaches the open mock with pi's login as Authorization and the target model",
			ok: Array.isReadonlyArrayNonEmpty(cleanCase) && pipe(cleanCase, Array.every(isAsSent)),
		},
		{
			name: "the canary case reaches the BAA mock with the BAA key and without the open credential",
			ok: holdsAny(played.canaries)(canary.baa) && pipe(baa, Array.every(isBaaOnly)),
		},
		{
			name: "the follow-up reaches the open mock with the stub in place of the sealed part",
			ok: holdsAny([sealedStub("pi")(handleAt(1))])(followUp.open),
		},
		{
			name: "each request reached the router with x-phi-session naming its pi session, the compaction's included",
			ok: Array.isReadonlyArrayNonEmpty(compacted) && sessionsHeld(played),
		},
	];
};

const piChecksOf = (played: PiPlayed): readonly Check[] => [
	{
		name: "pi install with the repository's git address adds the package to a fresh agent folder",
		ok: played.installed,
	},
	{ name: "phi-router doctor pi passes on the installed package", ok: played.doctored },
	{
		name: "phi-router doctor pi leaves nothing in a /tmp that starts empty",
		ok: played.doctored && Array.isReadonlyArrayEmpty(played.leftInTmp),
	},
	{ name: "no router answers on the port before the first pi starts", ok: !played.routerBefore },
	{
		name: "the first pi session leaves a router answering on the port PHI_ROUTER_PORT names",
		ok: Array.headNonEmpty(played.turns).routerUpAfterExit,
	},
	...wireChecksOf(played),
	{
		name: "after two pi sessions the state folder holds one verdict store per session id",
		ok:
			played.verdictStoreFiles.length === played.sessions.length &&
			pipe(played.sessions, Array.every(isStoredIn(played.verdictStoreFiles))),
	},
	{
		name: "each pi's own pid holds a lease once it exits",
		ok: pipe(
			played.turns,
			Array.every((turn) => Array.contains(turn.leasedAfterExit, turn.pid)),
		),
	},
	{ name: "the router is down within 11 s of the last pi exiting", ok: played.routerStopped },
	{
		name: "no output of pi and no file under the state folder holds pi's login",
		ok:
			!pipe(
				played.turns,
				Array.some((turn) => turn.showedLogin),
			) && !pipe(played.stored.fileTexts, Array.some(Str.includes(fakes.harnessToken))),
	},
	...commonChecksOf("pi")(played),
	...overflowChecksOf({
		after: played.overflow.after,
		all: played.turns,
		clock: played.clock,
		command: "/phi",
		lines: played.stored.lines,
		session: played.overflow.session,
		status: played.overflow.status,
	}),
];

const piOpen = refusing(harnesses.pi.answersOk.open);

const FollowUp = Schema.optionalKey(Schema.Literal("followUp"));

const PromptLine = Schema.fromJsonString(
	Schema.Struct({
		message: Schema.String,
		streamingBehavior: FollowUp,
		type: Schema.Literal("prompt"),
	}),
);

const runEnded = `"type":"agent_end"`;

const choosingSealed = '{"type":"set_model","provider":"phi","modelId":"sealed"}';

const choosingAuto = '{"type":"set_model","provider":"phi","modelId":"auto"}';

const piTools = ["Read", "Bash", "Edit", "Write"];

const Tool = Schema.Struct({ name: Schema.String });

const ToolNames = Schema.fromJsonString(Schema.Struct({ tools: Schema.Array(Tool) }));

const toolsOf = (sent: Sent): readonly string[] =>
	pipe(
		Schema.decodeOption(ToolNames)(sent.body),
		Option.map(({ tools }) => tools),
		Option.getOrElse(() => [{ name: "unreadable" }]),
		Array.map(({ name }) => name),
	);

const onlyPiTools = (sent: Sent): boolean =>
	pipe(
		toolsOf(sent),
		Array.every((name) => Array.contains(piTools, name)),
	);

const isPost = ({ method }: Sent): boolean => method === "POST";

const unjudged = 0;

const sealedModelChecksOf = (chosen: PhiTurned): readonly Check[] => {
	const sealed = pipe(chosen.baa, Array.filter(isPost));

	return [
		{
			name: "after /model phi/sealed, the next prompt reaches the BAA mock alone under the sealed model, with no judge call",
			ok:
				Array.isReadonlyArrayNonEmpty(sealed) &&
				pipe(
					sealed,
					Array.every(({ body }) => Str.includes(`"model":"${fakes.sealedModel.anthropic}"`)(body)),
				) &&
				!pipe(chosen.open, Array.some(isPost)) &&
				chosen.piecesJudged === unjudged,
		},
		{
			name: "pi's request on phi/sealed carries only pi's own tools, so the package ships no subagent tool",
			ok: pipe(sealed, Array.every(onlyPiTools)),
		},
	];
};

const piPhiPlay = Effect.fnUntraced(function* piPhiPlay<Turn extends PhiTurned, Failure, Needs>(
	turn: (asked: RpcLine) => Effect.Effect<Turn, Failure, Needs>,
	run: Run,
) {
	const typed = (message: string, turnEnd: string): Effect.Effect<Turn, Failure | Schema.SchemaError, Needs> =>
		Effect.flatMap(Schema.encodeEffect(PromptLine)({ message, type: "prompt" }), (line) =>
			turn({ stdinLine: `${line}\n`, turnEnd }),
		);

	const phi = yield* phiTurns((message) => typed(message, rpcAnswered));

	const sealing = yield* typed(run.phi.text, runEnded);

	const cleanLine = yield* Schema.encodeEffect(PromptLine)({ message: run.clean.text, type: "prompt" });
	const chosen = yield* turn({ stdinLine: `${choosingSealed}\n${cleanLine}\n`, turnEnd: runEnded });
	const overflowLine = yield* Schema.encodeEffect(PromptLine)({ message: overflowing, type: "prompt" });

	const insideLine = yield* Schema.encodeEffect(PromptLine)({
		message: insideStamp,
		streamingBehavior: "followUp",
		type: "prompt",
	});

	const overflowed = yield* turn({
		followUp: `${insideLine}\n`,
		stdinLine: `${choosingAuto}\n${overflowLine}\n`,
		turnEnd: runEnded,
	});

	const status = yield* typed("/phi", rpcAnswered);

	const checks: readonly Check[] = [
		...phiChecksOf(phi),
		...shownChecksOf({ harness: "pi", turns: phi }),
		sealCheckOf([sealing, ...phi.inOrder]),
		{
			name: "pi runs /phi and /phi pin as its extension command, which starts no run",
			ok: pipe(
				phi.inOrder,
				Array.every((turned) => turned.shown.handled),
			),
		},
		{
			name: "after the turn that seals, pi's status line names the BAA account and its model",
			ok: sealing.shown.piStatusNamesBaa,
		},
		...sealedModelChecksOf(chosen),
	];

	return {
		checks,
		overflow: { after: [overflowed] as const, status },
		turns: [...phi.inOrder, sealing, chosen, overflowed, status],
	};
});

export { piChecksOf, piOpen, piPhiPlay };
