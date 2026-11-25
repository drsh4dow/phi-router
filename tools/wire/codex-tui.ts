import { Array, Effect, Option, Schedule, String as Str, Struct, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const window = { height: "60", name: "codex", width: "250" } as const;

const pasteSettles = "1 second";

const timesIn = (pane: string, text: string): number => Str.split(pane, text).length;

const settled = 0;

const timedOut = 1;

interface Typed {
	readonly line: string;
	readonly shows: string;
}

const codexTui = Effect.fnUntraced(function* codexTui(run: {
	readonly env: Readonly<Record<string, string>>;
	readonly work: string;
	readonly socket: string;
	readonly session: string;
	readonly typed: readonly Typed[];
}) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const env = Struct.assign(run.env, { TERM: "xterm-256color" });

	const tmux = (args: readonly string[]): ReturnType<typeof spawner.string> =>
		spawner.string(
			ChildProcess.make("tmux", ["-S", run.socket, ...args], {
				cwd: run.work,
				env,
				extendEnv: false,
				stdin: "ignore",
			}),
		);

	const pane = tmux(["capture-pane", "-p", "-J", "-S", "-", "-t", window.name]);

	const shows = (done: (shown: string) => boolean): Effect.Effect<boolean, Effect.Error<typeof pane>> =>
		pane.pipe(
			Effect.repeat({ schedule: Schedule.spaced("1 second"), until: done }),
			Effect.timeoutOption("3 minutes"),
			Effect.map(Option.isSome),
		);

	const opened = ["-d", "-s", window.name, "-x", window.width, "-y", window.height];
	const codex = ["codex", "--no-daemon", "--dangerously-bypass-hook-trust", "resume", run.session];

	yield* Effect.acquireRelease(tmux(["new-session", ...opened, ...codex]), () => Effect.ignore(tmux(["kill-server"])));

	const started = yield* shows(Str.includes(`· ${run.work}`));

	const answered = yield* Effect.forEach(
		run.typed,
		({ line, shows: answer }) =>
			Effect.gen(function* typed() {
				const prompt = `› ${line}`;
				const before = yield* pane.pipe(Effect.map((shown) => timesIn(shown, prompt)));

				yield* tmux(["send-keys", "-t", window.name, "-l", line]);
				yield* Effect.sleep(pasteSettles);
				yield* tmux(["send-keys", "-t", window.name, "Enter"]);

				return yield* shows(
					(shown) =>
						timesIn(shown, prompt) > before &&
						pipe(Str.split(shown, prompt), Array.last, Option.exists(Str.includes(answer))),
				);
			}),
		{ concurrency: 1 },
	);

	const printed = yield* pane;

	if (started && pipe(answered, Array.every(Boolean))) {
		return { exitCode: settled, printed };
	}

	return { exitCode: timedOut, printed };
}, Effect.scoped);

export { codexTui };
