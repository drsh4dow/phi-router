import {
	Array,
	Effect,
	FileSystem,
	Option,
	Path,
	Predicate,
	Schema,
	String as Str,
	Stream,
	Struct,
	pipe,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Ran, StepRan } from "./account-checks.ts";
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

const Pinned = Schema.Struct({ gaveUp: Schema.Finite, rewrites: Schema.Finite, runs: Schema.Finite });

const Status = Schema.Struct({ pinned: Schema.optionalKey(Pinned) });

const pinnedOf = Schema.decodeOption(Schema.fromJsonString(Status));

const pinnedIn = Effect.fnUntraced(function* pinnedIn(
	router: { readonly url: string; readonly env: Readonly<Record<string, string>> },
	session: string,
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const { port } = new URL(router.url);
	const status = ["src/router/main.ts", "status", "--session", session, "--port", port];
	const handle = yield* spawner.spawn(ChildProcess.make("bun", status, { env: router.env, extendEnv: true }));
	const printed = yield* Stream.mkString(Stream.decodeText(handle.stdout));

	return pipe(
		pinnedOf(Str.trim(printed)),
		Option.flatMapNullishOr(({ pinned }) => pinned),
		Option.getOrElse(() => noPinnedRun),
	);
}, Effect.scoped);

const sessionOn = Effect.fnUntraced(function* sessionOn(harness: keyof typeof turnsOn, accounts: Accounts) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const relay = yield* relayedConfig(accounts.configHome, [voidedSsn]);
	const stateHome = yield* fs.makeTempDirectoryScoped({ prefix: "phi-accounts-state-" });
	const env = Struct.assign(accounts.env, { XDG_CONFIG_HOME: relay.configHome, XDG_STATE_HOME: stateHome });
	const router = yield* routerProcess(["bun", "src/router/main.ts"], env);
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
					onSome: ({ session }) => pinnedIn({ env, url: router.url }, session),
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
