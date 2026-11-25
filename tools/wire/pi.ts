import { Effect, FileSystem, Layer, Option, Path, Struct } from "effect";
import type { Outcome, Run } from "./checks.ts";
import { answers, freePort, leasedPids, refusedWithin } from "#tools/lifecycle/launched.ts";
import { during, followUp, withCredentialRule } from "./during.ts";
import { fakes, mocked } from "#tools/route/mocked-router.ts";
import { installedIn, piRun, place, rpcAnswered } from "./pi-run.ts";
import { piChecksOf, piOpen, piPhiPlay } from "./pi-checks.ts";
import { stampClockIn, storedIn } from "./stored.ts";
import { FetchHttpClient } from "effect/http";
import type { RpcLine } from "./pi-run.ts";
import { leftOf } from "./checks.ts";
import { piWire } from "#router/features/route/index.ts";

const sessions = ["17171717-1717-4717-8717-171717171717", "27272727-2727-4727-8727-272727272727"] as const;

const [first, second] = sessions;

type PiTurn = { readonly prompt: string } | RpcLine;

const compact = { stdinLine: `{"type":"compact"}\n`, turnEnd: rpcAnswered };

const storesIn = Effect.fnUntraced(function* storesIn(state: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	return yield* fs.readDirectory(path.join(state, "sessions"));
});

const routerOutlivesLastLease = 10_000;

const pollMargin = 1000;

const setUp = Effect.fnUntraced(function* setUp(run: Run) {
	const where = yield* place;

	const { breaches, env, received, roots, state } = yield* mocked({
		configExtras: { sealedModel: fakes.sealedModel },
		holdsPhi: run.judgeSeals,
		open: piOpen,
	});

	const port = yield* freePort;
	const http = yield* Layer.build(FetchHttpClient.layer);
	const routed = Struct.assign(env, { [piWire.portVariable]: String(port) });
	const install = yield* installedIn(where);
	const answering = Effect.provideContext(answers(port), http);

	const runOf = (asked: PiTurn, session: string): ReturnType<typeof piRun> => {
		const on = ["--model", "phi/auto", "--session-id", session];

		if ("prompt" in asked) {
			return piRun(where, ["-p", asked.prompt, ...on], { env: routed });
		}

		return piRun(where, ["--mode", "rpc", ...on], { env: routed, rpc: asked });
	};

	const turn = Effect.fnUntraced(function* turn(asked: PiTurn, session: string) {
		const played = yield* during(
			() => received,
			() => runOf(asked, session),
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
		stopped: Effect.provideContext(
			refusedWithin(port, routerOutlivesLastLease + pollMargin).pipe(Effect.option),
			http,
		),
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
		clock: yield* stampClockIn(state),
		overflow: phi.overflow,
		routerBefore,
		routerStopped: Option.isSome(stoppedWithin),
		verdictStoreFiles,
	});

	const checks = yield* withCredentialRule([...piChecksOf(played), ...phi.checks], () => breaches);

	return { checks, stored, turns: left.turns } satisfies Outcome;
});

export { piPlay };
