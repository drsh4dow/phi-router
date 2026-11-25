import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Effect, Number as Num, Option, Redacted, String as Str, Stream, pipe } from "effect";

const succeeded = 0;

const inTerminal = (script: string, args: readonly string[] = []): ChildProcess.Command =>
	ChildProcess.make("sh", ["-c", script, "sh", ...args], { stderr: "inherit", stdin: "inherit" });

const isTerminal = Effect.gen(function* isTerminal() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const code = yield* spawner.exitCode(inTerminal("[ -t 0 ]"));

	return code === succeeded;
});

const hiddenRead = String.raw`trap 'stty echo' EXIT; trap 'exit 130' HUP INT TERM; stty -echo || exit 1; printf '%s' "$1" >&2; IFS= read -r line || exit 1; printf '\n' >&2; printf '%s' "$line"`;

const pickRead = String.raw`saved=$(stty -g) || exit 1
trap 'stty "$saved"; printf "\033[?25h" >&2' EXIT
trap 'exit 130' HUP INT TERM
stty -icanon -echo min 1 time 0 || exit 1
question=$1; shift; count=$#; at=1
show() { i=1; for choice in "$@"; do mark=' '; [ "$i" -eq "$at" ] && mark=$(printf '\342\235\257'); printf '\033[2K%s %s\n' "$mark" "$choice"; i=$((i + 1)); done >&2; }
printf '\033[?25l%s\n' "$question" >&2
show "$@"
while :; do
	key=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')
	case $key in
	1b) case $(dd bs=1 count=2 2>/dev/null) in
		"[A") [ "$at" -gt 1 ] && at=$((at - 1)) ;;
		"[B") [ "$at" -lt "$count" ] && at=$((at + 1)) ;;
		esac ;;
	0a | 0d) break ;;
	04 | "") exit 1 ;;
	*) continue ;;
	esac
	printf '\033[%dA' "$count" >&2
	show "$@"
done
printf '\033[%dA\033[J' "$((count + 1))" >&2
i=1; for choice in "$@"; do [ "$i" -eq "$at" ] && printf '%s %s\n' "$question" "$choice" >&2; i=$((i + 1)); done
printf '%s' "$at"`;

const lineRead = Effect.fnUntraced(function* lineRead(script: string, args: readonly string[]) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const handle = yield* spawner.spawn(inTerminal(script, args));
	const line = yield* Stream.mkString(Stream.decodeText(handle.stdout));
	const code = yield* handle.exitCode;

	return Option.liftPredicate(line, () => code === succeeded);
}, Effect.scoped);

const hiddenLine = Effect.fnUntraced(function* hiddenLine(prompt: string) {
	const line = yield* lineRead(hiddenRead, [prompt]);

	return pipe(
		line,
		Option.map((text) => Redacted.make(text)),
	);
});

const firstChoice = 1;

const picked = Effect.fnUntraced(function* picked(question: string, choices: readonly string[]) {
	const line = yield* lineRead(pickRead, [question, ...choices]);

	return pipe(
		line,
		Option.flatMap((printed) => Num.parse(Str.trim(printed))),
		Option.map((at) => at - firstChoice),
	);
});

const enterPressed = Effect.gen(function* enterPressed() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const code = yield* spawner.exitCode(inTerminal("IFS= read -r line"));

	return code === succeeded;
});

const handedOver = Effect.fnUntraced(function* handedOver(
	argv: readonly [string, ...string[]],
	env: Readonly<Record<string, string>> = {},
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const [command, ...args] = argv;
	const options = { env, extendEnv: true, stderr: "inherit", stdin: "inherit", stdout: "inherit" } as const;

	return yield* spawner.exitCode(ChildProcess.make(command, args, options));
});

export { enterPressed, handedOver, hiddenLine, isTerminal, picked };
