import { Array, Effect, FileSystem, Option, Path, Predicate, Struct, pipe } from "effect";
import type { Ran, StepRan } from "./account-checks.ts";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { isSealedStore } from "./stored.ts";
import { laneLines } from "#tools/route/mocked-router.ts";
import { relayedConfig } from "./relay.ts";
import { routerProcess } from "#tools/route/router-process.ts";
import { turnsOn } from "./account-turns.ts";
import { voidedSsn } from "./cases.ts";

interface Accounts {
	readonly configHome: string;
	readonly env: Readonly<Record<string, string>>;
}

const textsUnder = Effect.fnUntraced(function* textsUnder(folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const names = yield* fs.readDirectory(folder, { recursive: true });
	const outsideSealedStore = pipe(names, Array.filter(Predicate.not(isSealedStore)));

	return yield* Effect.forEach(
		outsideSealedStore,
		(name) => fs.readFileString(path.join(folder, name)).pipe(Effect.orElseSucceed(() => "")),
		{ concurrency: 1 },
	);
});

const noPinnedRun = { gaveUp: 0, rewrites: 0, runs: 0 };

const sessionOn = Effect.fnUntraced(function* sessionOn(harness: keyof typeof turnsOn, accounts: Accounts) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const relay = yield* relayedConfig(accounts.configHome, [voidedSsn]);
	const stateHome = yield* fs.makeTempDirectoryScoped({ prefix: "phi-accounts-state-" });
	const env = Struct.assign(accounts.env, { XDG_CONFIG_HOME: relay.configHome, XDG_STATE_HOME: stateHome });
	const requests = yield* SessionRequests;
	const router = yield* routerProcess(["bun", "src/router/main.ts"], env);
	const port = Number(new URL(router.url).port);
	const state = path.join(stateHome, "phi-router");
	const steps = yield* turnsOn[harness]({ folders: env, url: router.url });
	const linesSoFar = laneLines(state).pipe(Effect.orElseSucceed(() => []));

	const played = yield* Effect.forEach(
		steps,
		(step) =>
			Effect.gen(function* stepPlayed() {
				const before = yield* linesSoFar;
				const turns = yield* step.play;
				const after = yield* linesSoFar;
				const lines = Array.drop(after, before.length);

				const pinned = yield* Option.match(Array.head(lines), {
					onNone: () => Effect.succeed(noPinnedRun),
					onSome: ({ session }) =>
						requests.status(port, session).pipe(
							Effect.map(({ pinned: run = noPinnedRun }) => run),
							Effect.orElseSucceed(() => noPinnedRun),
						),
				});

				return { lines, name: step.name, pinned, turns } satisfies StepRan;
			}),
		{ concurrency: 1 },
	);

	yield* router.kill;

	const relayed = yield* relay.relayed;
	const stateFileTexts = yield* textsUnder(state);

	return { relayed, stateFileTexts, steps: played } satisfies Ran;
});

export { sessionOn };
