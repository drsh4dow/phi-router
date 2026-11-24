import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Effect, Option, Redacted, Stream, pipe } from "effect";

const succeeded = 0;

const inTerminal = (script: string, args: readonly string[]): ChildProcess.Command =>
	ChildProcess.make("sh", ["-c", script, "sh", ...args], { stderr: "inherit", stdin: "inherit" });

const isTerminal = Effect.gen(function* isTerminal() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const code = yield* spawner.exitCode(inTerminal("[ -t 0 ]", []));

	return code === succeeded;
});

const hiddenRead = String.raw`trap 'stty echo' EXIT; trap 'exit 130' HUP INT TERM; stty -echo || exit 1; printf '%s' "$1" >&2; IFS= read -r line || exit 1; printf '\n' >&2; printf '%s' "$line"`;

const typedRead = String.raw`printf '%s' "$1" >&2; IFS= read -r line || exit 1; printf '%s' "$line"`;

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

const typedLine = (prompt: string): ReturnType<typeof lineRead> => lineRead(typedRead, prompt);

const enterPressed = Effect.gen(function* enterPressed() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const code = yield* spawner.exitCode(inTerminal("IFS= read -r line", []));

	return code === succeeded;
});

const handedOver = Effect.fnUntraced(function* handedOver(argv: readonly [string, ...string[]]) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const [command, ...args] = argv;

	return yield* spawner.exitCode(
		ChildProcess.make(command, args, { stderr: "inherit", stdin: "inherit", stdout: "inherit" }),
	);
});

export { enterPressed, handedOver, hiddenLine, isTerminal, typedLine };
