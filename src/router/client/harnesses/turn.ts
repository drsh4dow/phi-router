import { Array, Config, Effect, Option, Path, String as Str, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { PlatformError, Scope } from "effect";
import { loopback } from "#router/client/server.ts";

/** How one headless harness turn ended. */
type Turn =
	| { readonly kind: "exited"; readonly exitCode: number; readonly printed: string }
	| { readonly kind: "notStarted" }
	| { readonly kind: "timedOut" };

const turnPatience = "2 minutes";

/**
 * Runs the command `commandOf` makes for one headless harness turn, with what it printed on stdout and stderr, and ends it after 2 minutes.
 * The scope of `commandOf`, such as its temp folders, closes once the turn ends.
 *
 * @param {Function} commandOf The turn's command.
 * @returns {Function} The turn.
 */
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

/**
 * Runs one installer command, such as `claude plugin install`, in the caller's environment with no stdin, so it asks
 * nothing, and ends it after 2 minutes.
 */
const installRun = harnessTurn((argv: readonly [string, ...string[]]) => {
	const [command, ...args] = argv;

	return Effect.succeed(ChildProcess.make(command, args, { stdin: "ignore" }));
});

/**
 * A harness's own folder: the folder a command names when it is not empty, else the environment variable
 * `rule.variable`, else `rule.fallback` under the home folder.
 *
 * @param {object} rule The environment variable that names the folder, and the folder under the home folder.
 * @returns {Function} The folder, from the folder a command names or empty.
 */
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

/**
 * The proxy a headless turn gets: the discard port, where only root may listen, so the harness's own calls, such as
 * Codex's to GitHub and chatgpt.com, never leave the machine.
 */
const nowhere = `http://${loopback}:9`;

const developerExemption = "localhost";

/**
 * The proxy settings of a headless turn: every proxy variable at `nowhere`, and `NO_PROXY` naming only `localhost`, as a
 * developer behind a proxy often has it. The turn reaches the router only when the settings `on` writes exempt it from
 * the proxy, and it reaches no other host.
 */
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
