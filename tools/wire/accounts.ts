import { Array, Config, Console, Effect, FileSystem, Number as Num, Option, Path, Schema, pipe } from "effect";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { billed, checksOf, dollars, reportOf } from "./account-checks.ts";
import type { Ran } from "./account-checks.ts";
import type { Turn } from "./account-turns.ts";
import { laneLines } from "#tools/route/mocked-router.ts";
import { routerProcess } from "#tools/route/router-process.ts";
import { turnsOn } from "./account-turns.ts";

const runtimeAndScript = 2;

const Harness = Schema.Literals(["claude", "codex", "pi"]);

/** The router's environment: a fresh state folder, beside the caller's config folder when the caller names one. */
const routerEnv = Effect.fnUntraced(function* routerEnv() {
	const fs = yield* FileSystem.FileSystem;
	const state = yield* fs.makeTempDirectoryScoped({ prefix: "phi-accounts-state-" });
	const config = yield* Config.option(Config.String("XDG_CONFIG_HOME"));

	return Option.match(config, {
		onNone: () => ({ XDG_STATE_HOME: state }),
		onSome: (folder) => ({ XDG_CONFIG_HOME: folder, XDG_STATE_HOME: state }),
	});
});

const textsUnder = Effect.fnUntraced(function* textsUnder(folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const names = yield* fs.readDirectory(folder, { recursive: true });

	return yield* Effect.forEach(
		names,
		(name) => fs.readFileString(path.join(folder, name)).pipe(Effect.orElseSucceed(() => "")),
		{ concurrency: 1 },
	);
});

/** The router as its own process with a fresh state folder, and one session of `harness` through it. */
const sessionOf = Effect.fnUntraced(function* sessionOf(harness: typeof Harness.Type) {
	const path = yield* Path.Path;
	const env = yield* routerEnv();
	const router = yield* routerProcess(["bun", "src/router/main.ts"], env);
	const turns: readonly Turn[] = yield* turnsOn[harness]({ folders: env, url: router.url });
	const folder = path.join(env.XDG_STATE_HOME, "phi-router");
	const lines = yield* laneLines(folder);
	const stateFileTexts = yield* textsUnder(folder);

	return { lines, stateFileTexts, turns } satisfies Ran;
});

/**
 * `bun run wire:accounts <harness>` drives the real harness binary through the router on the real accounts that the
 * caller's `phi-router/config.json` names, in one session: a clean prompt, then a prompt whose canary is a voided SSN.
 * It prints each lane log line, the checks, the judge's cost and the BAA accounts' token cost, and exits non-zero when
 * a check fails or no price is known for the model a BAA account ran. Every account must hold a login folder or a key
 * the router reads, since the harness runs in throwaway folders with a fake login.
 */
const program = Effect.gen(function* program() {
	const [named = ""] = Array.drop(process.argv, runtimeAndScript);

	const harness = yield* Effect.filterOrFail(
		Effect.succeed(named),
		Schema.is(Harness),
		() => `bun run wire:accounts takes one harness, claude, codex or pi. It got "${named}".`,
	);

	const ran = yield* sessionOf(harness);
	const requests = Array.zip(ran.lines, ran.turns);
	const costs = pipe(requests, Array.map(billed));
	const baa = Option.map(Option.all(costs), Num.sumAll);
	const priced = { name: "tools/wire/spent.ts prices every model a BAA account ran", ok: Option.isSome(baa) };
	const checks = Array.append(checksOf(ran), priced);

	yield* Console.log(
		reportOf({ baa: Option.match(baa, { onNone: () => "unknown", onSome: dollars }), checks, harness, ran }),
	);

	return yield* Effect.filterOrFail(
		Effect.succeed(checks),
		Array.every(({ ok }) => ok),
		() => "an accounts check failed",
	);
});

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
