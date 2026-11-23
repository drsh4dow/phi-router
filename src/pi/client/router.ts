import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { CommandFailed, StatusJson, spelling } from "#shared/cli.ts";
import { Context, Effect, Layer, Result, Schema, Stream } from "effect";
import type { SessionId, Status } from "#shared/cli.ts";

/** The exit code of a command that did what it was asked. */
const succeeded = 0;

/**
 * `start` through `sh`, whose `$PPID` is pi's own pid, since pi spawns it directly. The lease is on that pid, as every
 * adapter's is on `$PPID`.
 */
const onParentPid = `exec "$0" "$@" --${spelling.start.pid} "$PPID"`;

/**
 * What `command` printed on stdout, or `CommandFailed` naming `name`, with what it printed on stdout and stderr, when it
 * did not run or exit 0.
 */
const printed = Effect.fn("Router.printed")(function* printed(name: string, command: string, args: readonly string[]) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

	const ran = yield* Effect.result(
		Effect.gen(function* ran() {
			const handle = yield* spawner.spawn(ChildProcess.make(command, args));

			const { errors, output } = yield* Effect.all(
				{
					errors: Stream.mkString(Stream.decodeText(handle.stderr)),
					output: Stream.mkString(Stream.decodeText(handle.stdout)),
				},
				{ concurrency: "unbounded" },
			);

			const exitCode = yield* handle.exitCode;

			return { errors, exitCode, output };
		}),
	);

	if (Result.isFailure(ran)) {
		return yield* CommandFailed.make({ cause: ran.failure, command: name });
	}

	if (ran.success.exitCode !== succeeded) {
		return yield* CommandFailed.make({ cause: `${ran.success.output}${ran.success.errors}`, command: name });
	}

	return ran.success.output;
}, Effect.scoped);

/** Asks the router on `port` about `session`. */
type Asking<Answer> = (session: typeof SessionId.Type, port: number) => Effect.Effect<Answer, CommandFailed>;

/** Runs the `phi-router` CLI at `program`, checks its exit code and decodes what it printed with the contract's schemas. */
class Router extends Context.Service<
	Router,
	{
		/** Leaves a lease for pi's process and `session` with the router on `port`, starting one when none runs there. */
		readonly start: (session: string, folder: string, port: number) => Effect.Effect<void, CommandFailed>;
		readonly status: Asking<typeof Status.Type>;
		readonly pin: Asking<void>;
		readonly unpin: Asking<void>;
	}
>()("phi-router/pi/client/router") {
	public static readonly layer = (
		program: string,
	): Layer.Layer<Router, never, ChildProcessSpawner.ChildProcessSpawner> =>
		Layer.effect(
			Router,
			Effect.gen(function* make() {
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				const spawning = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner);

				const start = Effect.fn("Router.start")(function* start(session: string, folder: string, port: number) {
					const { folder: folderFlag, name, port: portFlag, session: sessionFlag } = spelling.start;
					const lease = [`--${sessionFlag}`, session, `--${folderFlag}`, folder, `--${portFlag}`, String(port)];

					yield* spawning(printed(name, "sh", ["-c", onParentPid, program, name, ...lease]));
				});

				const asked = (
					command: string,
					session: typeof SessionId.Type,
					port: number,
				): Effect.Effect<string, CommandFailed> =>
					spawning(
						printed(command, program, [
							command,
							`--${spelling.status.session}`,
							session,
							`--${spelling.start.port}`,
							String(port),
						]),
					);

				const status = Effect.fn("Router.status")(function* status(session: typeof SessionId.Type, port: number) {
					const command = spelling.status.name;
					const output = yield* asked(command, session, port);
					const decoded = yield* Effect.result(Schema.decodeEffect(StatusJson)(output));

					if (Result.isFailure(decoded)) {
						return yield* CommandFailed.make({ cause: decoded.failure, command });
					}

					return decoded.success;
				});

				const pin: Asking<void> = (session, port) => Effect.asVoid(asked(spelling.pin.name, session, port));

				const unpin: Asking<void> = (session, port) => Effect.asVoid(asked(spelling.unpin.name, session, port));

				return Router.of({ pin, start, status, unpin });
			}),
		);
}

export { Router };
