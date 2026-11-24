import { Array, Effect, Option, Schema, String as Str, pipe } from "effect";
import type { Check, Played, Run } from "./checks.ts";
import { commonChecksOf, isAsSent, isBaaOnly } from "./checks.ts";
import { phiChecksOf, phiTurns, sealCheckOf, shownChecksOf } from "./phi-checks.ts";
import { Base64Url } from "effect/encoding";
import type { PhiTurned } from "./phi-checks.ts";
import type { RpcLine } from "./pi-run.ts";
import type { Sent } from "#router/client/mock-upstreams/index.ts";
import { fakes } from "#tools/route/mocked-router.ts";
import { foundIn } from "#tools/corpus/request-bodies.ts";
import { rpcAnswered } from "./pi-run.ts";
import { stubsFor } from "#router/features/border/index.ts";
import { windowsOf } from "./stored.ts";

interface PiTurned extends PhiTurned {
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
			(bodies) => foundIn({ bodies, tokens }),
			Array.isReadonlyArrayNonEmpty,
		);

const isStoredIn =
	(verdictStoreFiles: readonly string[]) =>
	(session: string): boolean =>
		Array.contains(verdictStoreFiles, `${Base64Url.encode(session)}.json`);

const firstSessionTurns = 4;

const requestsIn = (turns: readonly PiTurned[]): number =>
	pipe(
		turns,
		Array.flatMap(({ baa, open }) => [...open, ...baa]),
		Array.length,
	);

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
			ok: holdsAny([stubsFor.pi])(followUp.open),
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
			) && !pipe(played.stored.files, Array.some(Str.includes(fakes.harnessToken))),
	},
	...commonChecksOf("pi")(played),
];

const PromptLine = Schema.fromJsonString(Schema.Struct({ message: Schema.String, type: Schema.Literal("prompt") }));

/** What pi's RPC mode prints once a prompt's run has ended, after every extension's turn-end handler. */
const runEnded = `"type":"agent_end"`;

/** The RPC line that picks `phi/sealed`, as `/model phi/sealed` does in pi's TUI. */
const choosingSealed = '{"type":"set_model","provider":"phi","modelId":"sealed"}';

/** The tools pi itself gives a model of the provider `phi`, which pi names as Claude Code does. */
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
	turn: (asked: { readonly prompt: string } | RpcLine) => Effect.Effect<Turn, Failure, Needs>,
	run: Run,
) {
	const typed = (message: string, until: string): Effect.Effect<Turn, Failure | Schema.SchemaError, Needs> =>
		Effect.flatMap(Schema.encodeEffect(PromptLine)({ message, type: "prompt" }), (line) =>
			turn({ rpc: `${line}\n`, until }),
		);

	const phi = yield* phiTurns({
		clean: run.clean.text,
		command: (message) => typed(message, rpcAnswered),
		prompt: (prompt) => turn({ prompt }),
	});

	const sealing = yield* typed(run.phi.text, runEnded);

	const cleanLine = yield* Schema.encodeEffect(PromptLine)({ message: run.clean.text, type: "prompt" });
	const chosen = yield* turn({ rpc: `${choosingSealed}\n${cleanLine}\n`, until: runEnded });

	const checks: readonly Check[] = [
		...phiChecksOf({ cleanText: run.clean.text, turns: phi }),
		...shownChecksOf(phi),
		sealCheckOf([sealing, ...phi.inOrder]),
		{
			name: "pi runs /phi, /phi pin and /phi unpin as its extension command, which starts no run",
			ok: pipe(
				[phi.status, phi.pin, phi.unpin],
				Array.every((turned) => turned.shown.handled),
			),
		},
		{
			name: "after the turn that seals, pi's status line names the BAA account and its model",
			ok: sealing.shown.piStatusNamesBaa,
		},
		...sealedModelChecksOf(chosen),
	];

	return { checks, turns: [...phi.inOrder, sealing, chosen] };
});

export { piChecksOf, piPhiPlay };
