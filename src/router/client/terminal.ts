import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Effect, Option, Redacted, Stream, pipe } from "effect";

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

/** Prints `$1`, and reads one line with echo on. */
const typedRead = String.raw`printf '%s' "$1" >&2; IFS= read -r line || exit 1; printf '%s' "$line"`;

/** Runs `script`, which prints `prompt` and reads one line, and gives the line. None when the input ends first. */
const lineRead = Effect.fnUntraced(function* lineRead(script: string, prompt: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const handle = yield* spawner.spawn(inTerminal(script, [prompt]));
	const line = yield* Stream.mkString(Stream.decodeText(handle.stdout));
	const code = yield* handle.exitCode;

	return Option.liftPredicate(line, () => code === succeeded);
}, Effect.scoped);

const hiddenLine = Effect.fnUntraced(function* hiddenLine(prompt: string) {
	const line = yield* lineRead(hiddenRead, prompt);

	return pipe(
		line,
		Option.map((text) => Redacted.make(text)),
	);
});

/**
 * Prints `prompt` on the terminal and reads one line the human types. None when the input ends first.
 *
 * @param {string} prompt The prompt.
 * @returns {Effect.Effect} The line.
 */
const typedLine = (prompt: string): ReturnType<typeof lineRead> => lineRead(typedRead, prompt);

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

export { enterPressed, handedOver, hiddenLine, isTerminal, typedLine };
