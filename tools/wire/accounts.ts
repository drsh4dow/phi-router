import { Array, Config, Console, Effect, Option, Path, Schema } from "effect";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { checksOf, reportOf } from "./account-checks.ts";
import { FetchHttpClient } from "effect/http";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { mockedAccounts } from "./account-mocks.ts";
import { sessionOn } from "./account-session.ts";

const runtimeAndScript = 2;

const Harness = Schema.Literals(["claude", "codex", "pi", "pi-harness"]);

const ownAccounts = Effect.gen(function* ownAccounts() {
	const path = yield* Path.Path;
	const home = yield* Config.String("HOME");
	const configHome = yield* Config.String("XDG_CONFIG_HOME").pipe(Config.withDefault(path.join(home, ".config")));

	return { configHome, env: {} };
});

const program = Effect.gen(function* program() {
	const [named = "", mode = ""] = Array.drop(process.argv, runtimeAndScript);

	const harness = yield* Effect.filterOrFail(
		Effect.succeed(named),
		Schema.is(Harness),
		() =>
			`bun run wire:accounts takes one harness, claude, codex, pi or pi-harness, and --mocked for a dry run on mocks. It got "${named}".`,
	);

	const accounts = yield* Option.match(
		Option.liftPredicate(mode, (flag) => flag === "--mocked"),
		{
			onNone: () => ownAccounts,
			onSome: () => mockedAccounts(harness),
		},
	);

	const ran = yield* sessionOn(harness, accounts);
	const checks = checksOf(ran);

	yield* Console.log(reportOf({ checks, harness, ran }));

	return yield* Effect.filterOrFail(
		Effect.succeed(checks),
		Array.every(({ ok }) => ok),
		() => "an accounts check failed",
	);
});

NodeRuntime.runMain(
	program.pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer, SessionRequests.layer])),
);
