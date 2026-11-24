import { Effect, FileSystem, Layer, Option, Path, Struct } from "effect";
import type { Outcome, Run } from "./checks.ts";
import { answers, freePort, leasedPids, refusedWithin } from "#tools/lifecycle/launched.ts";
import { during, followUp, withCredentialRule } from "./during.ts";
import { fakes, mocked } from "#tools/route/mocked-router.ts";
import { installedIn, piRun, place, rpcAnswered } from "./pi-run.ts";
import { piChecksOf, piPhiPlay } from "./pi-checks.ts";
import { FetchHttpClient } from "effect/http";
import type { RpcLine } from "./pi-run.ts";
import { leftOf } from "./checks.ts";
import { piWire } from "#router/features/route/index.ts";
import { storedIn } from "./stored.ts";

const sessions = ["17171717-1717-4717-8717-171717171717", "27272727-2727-4727-8727-272727272727"] as const;

const [first, second] = sessions;

/** A turn: a prompt with `-p`, or a line pi's RPC mode reads, such as the `compact` command. */
type Asked = { readonly prompt: string } | RpcLine;

/** How pi runs a turn: its arguments, the RPC line its stdin holds, empty for a prompt, and what ends the turn. */
interface PiArgs extends RpcLine {
	readonly args: readonly string[];
}

const runOf = (session: string, asked: Asked): PiArgs => {
	const on = ["--model", "phi/auto", "--session-id", session];

	if ("prompt" in asked) {
		return { args: ["-p", asked.prompt, ...on], rpc: "", until: rpcAnswered };
	}

	return Struct.assign(asked, { args: ["--mode", "rpc", ...on] });
};

const compact = { rpc: `{"type":"compact"}\n`, until: rpcAnswered };

const storesIn = Effect.fnUntraced(function* storesIn(state: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	return yield* fs.readDirectory(path.join(state, "sessions"));
});

/** How long the router may outlive the last pi, by ADR 0005, with a second for the poll. */
const outlives = 11_000;

const setUp = Effect.fnUntraced(function* setUp(run: Run) {
	const where = yield* place;

	const { breaches, env, received, roots, state } = yield* mocked({
		configExtras: { sealedModel: fakes.sealedModel },
		holdsPhi: run.judgeSeals,
	});

	const port = yield* freePort;
	const http = yield* Layer.build(FetchHttpClient.layer);
	const routed = Struct.assign(env, { [piWire.portVariable]: String(port) });
	const install = yield* installedIn(where);
	const answering = Effect.provideContext(answers(port), http);

	const turn = Effect.fnUntraced(function* turn(asked: Asked, session: string) {
		const { args, rpc, until } = runOf(session, asked);

		const played = yield* during(
			() => received,
			() => piRun(where, args, { env: routed, rpc, until }),
		);

		const leasedAfterExit = yield* leasedPids(state).pipe(Effect.orElseSucceed((): readonly number[] => []));
		const routerUpAfterExit = yield* answering;

		return Struct.assign(played, { leasedAfterExit, routerUpAfterExit });
	});

	return {
		answering,
		breaches,
		install,
		roots,
		state,
		stopped: Effect.provideContext(refusedWithin(port, outlives).pipe(Effect.option), http),
		turn,
	};
});

const piPlay = Effect.fnUntraced(function* piPlay(run: Run) {
	const { answering, breaches, install, roots, state, stopped, turn } = yield* setUp(run);
	const routerBefore = yield* answering;

	const turns = yield* Effect.all(
		[
			turn({ prompt: run.clean.text }, first),
			turn({ prompt: run.phi.text }, first),
			turn({ prompt: followUp }, first),
			turn(compact, first),
			turn({ prompt: run.clean.text }, second),
		],
		{ concurrency: 1 },
	);

	const phi = yield* piPhiPlay((asked) => turn(asked, second), run);
	const stoppedWithin = yield* stopped;
	const [stored, verdictStoreFiles] = yield* Effect.all([storedIn(state, roots), storesIn(state)], { concurrency: 1 });

	const left = leftOf({
		prompts: [run.clean.text, run.phi.text, followUp],
		run,
		sessions,
		stored,
		turns: [...turns, ...phi.turns] as const,
	});

	const played = Struct.assign(Struct.assign(left, install), {
		routerBefore,
		routerStopped: Option.isSome(stoppedWithin),
		verdictStoreFiles,
	});

	const checks = yield* withCredentialRule([...piChecksOf(played), ...phi.checks], () => breaches);

	return { checks, stored, turns: left.turns } satisfies Outcome;
});

export { piPlay };
