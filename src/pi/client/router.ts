import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { CommandFailed, ModelsJson, StatusJson, spelling } from "#shared/cli.ts";
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

/**
 * Decodes what the command `name` printed, a failure as `CommandFailed` naming `name`.
 *
 * @param {string} name The command.
 * @param {Function} decode The contract's decoder of what it prints.
 * @returns {Function} The decoder.
 */
const decodedAs =
	<Decoded>(name: string, decode: (output: string) => Effect.Effect<Decoded, Schema.SchemaError>) =>
	(output: string): Effect.Effect<Decoded, CommandFailed> =>
		Effect.mapError(decode(output), (cause) => CommandFailed.make({ cause, command: name }));

const decodedModels = decodedAs(spelling.models.name, Schema.decodeEffect(ModelsJson));

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
		/** The models `phi/auto` and `phi/sealed` run for each vendor `config.json` names, without asking a router. */
		readonly models: Effect.Effect<typeof ModelsJson.Type, CommandFailed>;
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

					return yield* decodedAs(command, Schema.decodeEffect(StatusJson))(output);
				});

				const models = spawning(printed(spelling.models.name, program, [spelling.models.name])).pipe(
					Effect.flatMap(decodedModels),
				);

				const pin: Asking<void> = (session, port) => Effect.asVoid(asked(spelling.pin.name, session, port));

				const unpin: Asking<void> = (session, port) => Effect.asVoid(asked(spelling.unpin.name, session, port));

				return Router.of({ models, pin, start, status, unpin });
			}),
		);
}

export { Router };
