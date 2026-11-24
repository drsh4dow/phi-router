import { Array, Config, Effect, Option, Path, String as Str, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { PlatformError, Scope } from "effect";
import { loopback } from "#router/client/router-port/index.ts";

type Turn =
	| { readonly kind: "exited"; readonly exitCode: number; readonly printed: string }
	| { readonly kind: "notStarted" }
	| { readonly kind: "timedOut" };

const turnPatience = "2 minutes";

const harnessTurn = <Asked, Failure, Needs>(
	commandOf: (asked: Asked) => Effect.Effect<ChildProcess.Command, Failure, Needs>,
): ((
	asked: Asked,
) => Effect.Effect<
	Turn,
	Failure | PlatformError.PlatformError,
	Exclude<Needs, Scope.Scope> | ChildProcessSpawner.ChildProcessSpawner
>) =>
	Effect.fnUntraced(
		function* turn(asked: Asked) {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const command = yield* commandOf(asked);
			const started = yield* Effect.option(spawner.spawn(command));

			if (Option.isNone(started)) {
				return { kind: "notStarted" } satisfies Turn;
			}

			const { exitCode, stderr, stdout } = started.value;
			const printed = yield* Stream.mkString(Stream.decodeText(Stream.merge(stdout, stderr)));
			const code = yield* exitCode;

			return { exitCode: Number(code), kind: "exited", printed } satisfies Turn;
		},
		Effect.timeoutOption(turnPatience),
		Effect.map(Option.getOrElse((): Turn => ({ kind: "timedOut" }))),
		Effect.scoped,
	);

const installRun = harnessTurn((argv: readonly [string, ...string[]]) => {
	const [command, ...args] = argv;

	return Effect.succeed(ChildProcess.make(command, args, { stdin: "ignore" }));
});

const harnessFolder =
	(rule: {
		readonly variable: string;
		readonly fallback: string;
	}): ((named: string) => Effect.Effect<string, Config.ConfigError, Path.Path>) =>
	(named) =>
		Effect.gen(function* folder() {
			const path = yield* Path.Path;
			const fromEnv = yield* Config.String(rule.variable).pipe(Config.withDefault(""));
			const home = yield* Config.String("HOME");

			return pipe(
				[named, fromEnv],
				Array.findFirst(Str.isNonEmpty),
				Option.getOrElse(() => path.join(home, rule.fallback)),
			);
		});

const nowhere = `http://${loopback}:9`;

const developerExemption = "localhost";

const behindDeadProxy = {
	ALL_PROXY: nowhere,
	HTTPS_PROXY: nowhere,
	HTTP_PROXY: nowhere,
	NO_PROXY: developerExemption,
	all_proxy: nowhere,
	http_proxy: nowhere,
	https_proxy: nowhere,
	no_proxy: developerExemption,
} as const;

export { behindDeadProxy, harnessFolder, harnessTurn, installRun };

export type { Turn };
