import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Effect, Option, Redacted, Stream } from "effect";

const succeeded = 0;

/**
 * A POSIX shell that runs `script` with `args` on this process's own stdin and stderr, and pipes its stdout back.
 *
 * @param {string} script The script.
 * @param {readonly string[]} args Its positional parameters.
 * @returns {ChildProcess.Command} The command.
 */
const inTerminal = (script: string, args: readonly string[]): ChildProcess.Command =>
	ChildProcess.make("sh", ["-c", script, "sh", ...args], { stderr: "inherit", stdin: "inherit" });

/** Whether this process's stdin is a terminal, as `[ -t 0 ]` says in a shell that inherits it. */
const isTerminal = Effect.gen(function* isTerminal() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const code = yield* spawner.exitCode(inTerminal("[ -t 0 ]", []));

	return code === succeeded;
});

/** Turns echo off, prints `$1`, reads one line, and gives echo back however the shell ends. */
const hiddenRead = String.raw`trap 'stty echo' EXIT; trap 'exit 130' HUP INT TERM; stty -echo || exit 1; printf '%s' "$1" >&2; IFS= read -r line || exit 1; printf '\n' >&2; printf '%s' "$line"`;

/**
 * Prints `prompt` on the terminal and reads one line with echo off, so nothing the human types or pastes shows. None
 * when the input ends first. The line passes through a pipe from the shell, and never through an argument, a file or
 * the environment.
 */
const hiddenLine = Effect.fnUntraced(function* hiddenLine(prompt: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const handle = yield* spawner.spawn(inTerminal(hiddenRead, [prompt]));
	const line = yield* Stream.mkString(Stream.decodeText(handle.stdout));
	const code = yield* handle.exitCode;

	return Option.liftPredicate(Redacted.make(line), () => code === succeeded);
}, Effect.scoped);

/** Whether the human pressed Enter, false when the input ends first. */
const enterPressed = Effect.gen(function* enterPressed() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const code = yield* spawner.exitCode(inTerminal("IFS= read -r line", []));

	return code === succeeded;
});

/** Runs `argv` on this process's terminal, its stdin, stdout and stderr, until it exits, and gives its exit code. */
const handedOver = Effect.fnUntraced(function* handedOver(argv: readonly [string, ...string[]]) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const [command, ...args] = argv;

	return yield* spawner.exitCode(
		ChildProcess.make(command, args, { stderr: "inherit", stdin: "inherit", stdout: "inherit" }),
	);
});

export { enterPressed, handedOver, hiddenLine, isTerminal };
