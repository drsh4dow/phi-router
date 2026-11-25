import { Array, Context, Effect, Layer, Record, Result, Schema, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { CommandFailed, ModelsJson, SetupAnswersJson, SetupStepJson, StatusJson, spelling } from "#shared/cli.ts";
import type { SessionId, SetupVendor, Status } from "#shared/cli.ts";
import type { Redacted } from "effect";

const successExitCode = 0;

const onParentPid = `exec "$0" "$@" --${spelling.start.pid} "$PPID"`;

const harness = "pi";

type Shown = (line: string) => Effect.Effect<void>;

const unshown: Shown = () => Effect.void;

interface Spawned {
	readonly program: string;
	readonly args: readonly string[];
	readonly env: Record.ReadonlyRecord<string, Readonly<Redacted.Redacted>>;
	readonly shown: Shown;
}

const printed = Effect.fn("Router.printed")(function* printed(name: string, spawned: Spawned) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

	const ran = yield* Effect.result(
		Effect.gen(function* ran() {
			const handle = yield* spawner.spawn(
				ChildProcess.make(spawned.program, spawned.args, { env: spawned.env, extendEnv: true }),
			);

			const { errors, lines } = yield* Effect.all(
				{
					errors: Stream.mkString(Stream.decodeText(handle.stderr)),
					lines: handle.stdout.pipe(
						Stream.decodeText,
						Stream.splitLines,
						Stream.tap(spawned.shown),
						Stream.runCollect,
					),
				},
				{ concurrency: "unbounded" },
			);

			const exitCode = yield* handle.exitCode;

			return { errors, exitCode, output: Array.join(lines, "\n") };
		}),
	);

	if (Result.isFailure(ran)) {
		return yield* CommandFailed.make({ cause: ran.failure, command: name });
	}

	if (ran.success.exitCode !== successExitCode) {
		return yield* CommandFailed.make({ cause: `${ran.success.output}\n${ran.success.errors}`, command: name });
	}

	return ran.success.output;
}, Effect.scoped);

const decodedAs =
	<Decoded>(name: string, decode: (output: string) => Effect.Effect<Decoded, Schema.SchemaError>) =>
	(output: string): Effect.Effect<Decoded, CommandFailed> =>
		Effect.mapError(decode(output), (cause) => CommandFailed.make({ cause, command: name }));

const decodedModels = decodedAs(spelling.models.name, Schema.decodeEffect(ModelsJson));

const decodedStep = decodedAs(spelling.setup.name, Schema.decodeEffect(SetupStepJson));

type Asking<Answer> = (session: typeof SessionId.Type, port: number) => Effect.Effect<Answer, CommandFailed>;

type Answers = typeof SetupAnswersJson.Type;

interface TypedKey {
	readonly vendor: typeof SetupVendor.Type;
	readonly key: Readonly<Redacted.Redacted>;
}

interface SetUp {
	readonly answers: Answers;
	readonly keys: readonly TypedKey[];
	readonly shown: Shown;
}

class Router extends Context.Service<
	Router,
	{
		readonly start: (session: string, folder: string, port: number) => Effect.Effect<void, CommandFailed>;
		readonly status: Asking<typeof Status.Type>;
		readonly pin: Asking<void>;
		readonly unpin: Asking<void>;
		readonly models: Effect.Effect<typeof ModelsJson.Type, CommandFailed>;
		readonly setupStep: (answers: Answers) => Effect.Effect<typeof SetupStepJson.Type, CommandFailed>;
		readonly setUp: (given: SetUp) => Effect.Effect<void, CommandFailed>;
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

				const run = (name: string, args: readonly string[]): Effect.Effect<string, CommandFailed> =>
					spawning(printed(name, { args, env: {}, program, shown: unshown }));

				const start = Effect.fn("Router.start")(function* start(session: string, folder: string, port: number) {
					const { folder: folderFlag, name, port: portFlag, session: sessionFlag } = spelling.start;
					const lease = [`--${sessionFlag}`, session, `--${folderFlag}`, folder, `--${portFlag}`, String(port)];

					yield* spawning(
						printed(name, {
							args: ["-c", onParentPid, program, name, ...lease],
							env: {},
							program: "sh",
							shown: unshown,
						}),
					);
				});

				const asked = (
					command: string,
					session: typeof SessionId.Type,
					port: number,
				): Effect.Effect<string, CommandFailed> =>
					run(command, [
						command,
						`--${spelling.status.session}`,
						session,
						`--${spelling.start.port}`,
						String(port),
					]);

				const status = Effect.fn("Router.status")(function* status(session: typeof SessionId.Type, port: number) {
					const command = spelling.status.name;
					const output = yield* asked(command, session, port);

					return yield* decodedAs(command, Schema.decodeEffect(StatusJson))(output);
				});

				const models = Effect.flatMap(run(spelling.models.name, [spelling.models.name]), decodedModels);

				const pin: Asking<void> = (session, port) => Effect.asVoid(asked(spelling.pin.name, session, port));

				const unpin: Asking<void> = (session, port) => Effect.asVoid(asked(spelling.unpin.name, session, port));

				const setupArgs = Effect.fnUntraced(function* setupArgs(flag: string, answers: Answers) {
					const { answers: answersFlag, name } = spelling.setup;

					const encoded = yield* Effect.mapError(Schema.encodeEffect(SetupAnswersJson)(answers), (cause) =>
						CommandFailed.make({ cause, command: name }),
					);

					return [name, harness, `--${flag}`, `--${answersFlag}`, encoded];
				});

				const setupStep = Effect.fn("Router.setupStep")(function* setupStep(answers: Answers) {
					const args = yield* setupArgs(spelling.setup.json, answers);
					const output = yield* run(spelling.setup.name, args);

					return yield* decodedStep(output);
				});

				const setUp = Effect.fn("Router.setUp")(function* setUp(given: SetUp) {
					const args = yield* setupArgs(spelling.setup.apply, given.answers);

					const env = pipe(
						given.keys,
						Array.map(({ key, vendor }) => [spelling.setup.keys[vendor], key] as const),
						Record.fromEntries,
					);

					yield* spawning(printed(spelling.setup.name, { args, env, program, shown: given.shown }));
				});

				return Router.of({ models, pin, setUp, setupStep, start, status, unpin });
			}),
		);
}

export { Router };

export type { TypedKey };
