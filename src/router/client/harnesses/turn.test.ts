import { Array, Effect, Fiber, Option, Ref, Sink, String as Str, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { assert, it } from "@effect/vitest";
import { TestClock } from "effect/testing";
import type { Turn } from "./index.ts";
import { installRun } from "./index.ts";

const anyPid = 1;

const succeeded = 0;

const installArgv: readonly [string, ...string[]] = ["claude", "plugin", "install", "phi-router@phi-router"];

const endings = {
	exits: Effect.succeed(ChildProcessSpawner.ExitCode(succeeded)),
	hangs: Effect.never,
};

interface Installer {
	readonly ending: keyof typeof endings;
	readonly stdout: string;
	readonly stderr: string;
}

const handleOf = (installer: Installer): ChildProcessSpawner.ChildProcessHandle =>
	ChildProcessSpawner.makeHandle({
		all: Stream.empty,
		exitCode: endings[installer.ending],
		getInputFd: () => Sink.drain,
		getOutputFd: () => Stream.empty,
		isRunning: Effect.succeed(true),
		kill: () => Effect.void,
		pid: ChildProcessSpawner.ProcessId(anyPid),
		stderr: Stream.encodeText(Stream.make(installer.stderr)),
		stdin: Sink.drain,
		stdout: Stream.encodeText(Stream.make(installer.stdout)),
		unref: Effect.die("a harness turn never unrefs its process"),
	});

type Exited = Extract<Turn, { readonly kind: "exited" }>;

const isExited = (turn: Turn): turn is Exited => turn.kind === "exited";

const linesOf = (turn: Turn): readonly string[] =>
	pipe(
		Option.liftPredicate(turn, isExited),
		Option.map(({ printed }) => Str.split(printed, "\n")),
		Option.getOrElse(() => []),
	);

const ranWith = Effect.fnUntraced(function* ranWith(installer: Installer) {
	const spawned = yield* Ref.make<readonly ChildProcess.Command[]>([]);

	const spawner = ChildProcessSpawner.make((command) =>
		Effect.as(Ref.update(spawned, Array.append(command)), handleOf(installer)),
	);

	const turn = yield* Effect.forkChild(
		Effect.provideService(installRun(installArgv), ChildProcessSpawner.ChildProcessSpawner, spawner),
	);

	return { spawned, turn };
});

const timedOut = Effect.gen(function* timedOut() {
	const { turn } = yield* ranWith({ ending: "hangs", stderr: "", stdout: "" });

	yield* TestClock.adjust("2 minutes");

	const ended = yield* Fiber.join(turn);

	assert.deepStrictEqual(ended, { kind: "timedOut" });
});

const printed = Effect.gen(function* printed() {
	const { spawned, turn } = yield* ranWith({
		ending: "exits",
		stderr: "installer warning\n",
		stdout: "installed phi-router\n",
	});

	const ended = yield* Fiber.join(turn);
	const commands = yield* Ref.get(spawned);

	const stdin = pipe(
		Array.head(commands),
		Option.filter(ChildProcess.isStandardCommand),
		Option.flatMap(({ options }) => Option.fromNullishOr(options.stdin)),
	);

	const lines = linesOf(ended);

	assert.deepStrictEqual(
		{
			kind: ended.kind,
			stderr: Array.contains(lines, "installer warning"),
			stdin: Option.getOrElse(stdin, () => "pipe"),
			stdout: Array.contains(lines, "installed phi-router"),
		},
		{ kind: "exited", stderr: true, stdin: "ignore", stdout: true },
	);
});

it.effect("an installer still running after 2 minutes ends its turn as timed out", () => timedOut);

it.effect("an installer runs with no stdin, and its turn holds what it printed on stdout and stderr", () => printed);
