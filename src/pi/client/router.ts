import type { AnswerCheck, AnswerChecked, SessionId, SetupVendor, Status } from "#shared/cli.ts";
import {
	AnswerCheckJson,
	AnswerCheckedJson,
	CommandFailed,
	ModelsJson,
	SetupAnswersJson,
	SetupStepJson,
	StatusJson,
	spelling,
} from "#shared/cli.ts";
import { Array, Context, Effect, Layer, Record, Result, Schema, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
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
	readonly input?: string;
	readonly shown: Shown;
}

const printed = Effect.fn("Router.printed")(function* printed(name: string, spawned: Spawned) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const stdin = { stream: Stream.encodeText(Stream.make(spawned.input ?? "")) };

	const ran = yield* Effect.result(
		Effect.gen(function* ran() {
			const handle = yield* spawner.spawn(
				ChildProcess.make(spawned.program, spawned.args, { env: spawned.env, extendEnv: true, stdin }),
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
		readonly start: (session: string, folder: string, port: number) => Effect.Effect<string, CommandFailed>;
		readonly status: Asking<typeof Status.Type>;
		readonly answerCheck: (
			asked: typeof AnswerCheck.Type,
			port: number,
		) => Effect.Effect<typeof AnswerChecked.Type, CommandFailed>;
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

					return yield* spawning(
						printed(name, {
							args: ["-c", onParentPid, program, name, ...lease],
							env: {},
							program: "sh",
							shown: unshown,
						}),
					);
				});

				const status = Effect.fn("Router.status")(function* status(session: typeof SessionId.Type, port: number) {
					const command = spelling.status.name;

					const output = yield* run(command, [
						command,
						`--${spelling.status.session}`,
						session,
						`--${spelling.start.port}`,
						String(port),
					]);

					return yield* decodedAs(command, Schema.decodeEffect(StatusJson))(output);
				});

				const answerCheck = Effect.fn("Router.answerCheck")(function* answerCheck(
					asked: typeof AnswerCheck.Type,
					port: number,
				) {
					const command = spelling.answerCheck.name;
					const input = yield* Effect.orDie(Schema.encodeEffect(AnswerCheckJson)(asked));

					const output = yield* spawning(
						printed(command, {
							args: [command, `--${spelling.start.port}`, String(port)],
							env: {},
							input,
							program,
							shown: unshown,
						}),
					);

					return yield* decodedAs(command, Schema.decodeEffect(AnswerCheckedJson))(output);
				});

				const models = Effect.flatMap(run(spelling.models.name, [spelling.models.name]), decodedModels);

				const setupArgs = Effect.fnUntraced(function* setupArgs(flag: string, answers: Answers) {
					const { answers: answersFlag, name } = spelling.setup;

					const encoded = yield* Effect.orDie(Schema.encodeEffect(SetupAnswersJson)(answers));

					return [name, harness, `--${flag}`, `--${answersFlag}`, encoded];
				});

				const setupStep = Effect.fn("Router.setupStep")(function* setupStep(answers: Answers) {
					const args = yield* setupArgs(spelling.setup.json, answers);
					const output = yield* run(spelling.setup.name, args);

					return yield* decodedAs(spelling.setup.name, Schema.decodeEffect(SetupStepJson))(output);
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

				return Router.of({ answerCheck, models, setUp, setupStep, start, status });
			}),
		);
}

export { Router };

export type { Answers, TypedKey };
