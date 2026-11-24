import {
	Array,
	Context,
	DateTime,
	Effect,
	Equal,
	Layer,
	Option,
	Schema,
	String as Str,
	Stream,
	Struct,
	pipe,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { PlatformError, Scope } from "effect";
import type { Pid } from "#shared/cli.ts";

/** When a process started, as `ps` prints it under `LC_ALL=C TZ=UTC`. Only ever compared for equality. */
const Started = Schema.NonEmptyString;

interface LiveProcess {
	readonly pid: number;
	readonly started: typeof Started.Type;
}

interface PsRow extends LiveProcess {
	readonly zombie: boolean;
}

/** A `ps` that has not answered by then has not read the processes. */
const psPatience = "2 seconds";

/** `sh` execs `ps`, so `$$` is the pid of `ps` itself, and `ps` lists itself beside the pids in `$1`. */
const listing = 'exec ps -o pid=,stat=,lstart= -p "$$$1"';

/** A fixed format for `lstart`, and a SIGKILL for a `ps` still running 1 s after its SIGTERM. */
const psOptions = {
	env: { LC_ALL: "C", TZ: "UTC" },
	extendEnv: true,
	forceKillAfter: "1 second",
	stderr: "ignore",
} as const;

const monthsByNumber = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** One whole row of `ps -o pid=,stat=,lstart=` under `LC_ALL=C`, such as `42 Ss   Sat Nov 21 10:45:11 2026`. */
const rowPattern =
	/^(?<pid>\d+) +(?<state>\S+) +(?<started>(?<weekday>[A-Z][a-z]{2}) (?<month>[A-Z][a-z]{2}) +(?<day>\d{1,2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) (?<year>\d{4}))$/u;

/**
 * Whether a start time names a real second: its parts, weekday included, survive a round trip through the calendar.
 *
 * @param {Readonly<Record<string, string>>} started The groups of a row that matched `rowPattern`.
 * @returns {boolean} Whether no part is out of range.
 */
const isReal = (started: Readonly<Record<string, string>>): boolean => {
	const { day = "", hour = "", minute = "", month = "", second = "", weekday = "", year = "" } = started;

	const parts = {
		day: Number(day),
		hour: Number(hour),
		millisecond: 0,
		minute: Number(minute),
		month: monthsByNumber.indexOf(month),
		second: Number(second),
		year: Number(year),
	};

	const named = Struct.assign(parts, { weekDay: weekdays.indexOf(weekday) });

	return pipe(
		DateTime.make(parts),
		Option.map(DateTime.toPartsUtc),
		Option.exists((made) => Equal.equals(made, named)),
	);
};

const succeeded = 0;

/**
 * `cd -P` follows every link as the kernel does, `..` included, and `pwd -P` prints the folder it reached. An empty
 * `CDPATH` keeps a relative folder relative to the working folder.
 */
const resolving = 'cd -P -- "$1" && pwd -P';

/**
 * The real path of `folder` as the operating system resolves it, relative to this process's working folder, or `folder`
 * as typed when the operating system cannot resolve it.
 *
 * @param {string} folder A folder as typed, absolute or relative.
 * @returns {Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner>} Its real path, or `folder`.
 */
const realFolder = (folder: string): Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* resolved() {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const options = { env: { CDPATH: "" }, extendEnv: true, stderr: "ignore" } as const;
		const handle = yield* spawner.spawn(ChildProcess.make("/bin/sh", ["-c", resolving, "sh", folder], options));
		const printed = yield* Stream.mkString(Stream.decodeText(handle.stdout));

		if ((yield* handle.exitCode) !== succeeded) {
			return folder;
		}

		return Str.replace(/\n$/u, "")(printed);
	}).pipe(
		Effect.scoped,
		Effect.orElseSucceed(() => folder),
	);

const rowOf = (line: string): Option.Option<PsRow> => {
	const matched = rowPattern.exec(Str.trim(line));

	return pipe(
		Option.fromNullishOr(matched),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
		Option.filter(isReal),
		Option.map(({ pid = "", state = "", started = "" }) => ({
			pid: Number(pid),
			started,
			zombie: Str.startsWith("Z")(state),
		})),
	);
};

/**
 * The rows of a read that proved it worked, and `None` for any other. `ps` always lists itself, so a read that worked
 * exited 0, every line of it parsed whole, and `ps`'s own row is among them. `ps -p` exits 1 both when no pid matched
 * and when it failed, which is why `ps` lists itself.
 *
 * @param {string} printed What `ps` printed.
 * @param {number} exitCode How `ps` exited.
 * @param {number} self The pid of `ps`.
 * @returns {Option.Option<readonly PsRow[]>} Every row, or `None`.
 */
const provenRows = (printed: string, exitCode: number, self: number): Option.Option<readonly PsRow[]> => {
	if (exitCode !== succeeded) {
		return Option.none();
	}

	const lines = pipe(printed, Str.replace(/\n$/u, ""), Str.split("\n"));

	return pipe(lines, Array.map(rowOf), Option.all, Option.filter(Array.some(({ pid }) => pid === self)));
};

class Processes extends Context.Service<
	Processes,
	{
		/**
		 * Each of `pids` that runs now, with its start time. A pid with no process, or a zombie, is absent. One `ps` call.
		 * `None` when the read did not prove it worked: `ps` was missing or could not be spawned, failed, printed what
		 * does not parse, or took longer than 2 s. Then nothing is known of the processes.
		 */
		readonly running: (pids: readonly (typeof Pid.Type)[]) => Effect.Effect<Option.Option<readonly LiveProcess[]>>;
		/**
		 * Starts `command` in its own session with no stdio and lets go of it, so it outlives the caller. While the
		 * caller's scope is open, `exited` reads, without waiting, the code the process exited with: none while it runs,
		 * and none when a signal ended it.
		 */
		readonly launched: (
			command: readonly [string, ...string[]],
		) => Effect.Effect<
			{ readonly exited: Effect.Effect<Option.Option<number>> },
			PlatformError.PlatformError,
			Scope.Scope
		>;
	}
>()("phi-router/router/client/processes") {
	public static readonly layer = Layer.effect(
		Processes,
		Effect.gen(function* make() {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

			const read = Effect.fnUntraced(function* read(pids: readonly (typeof Pid.Type)[]) {
				const listed = pipe(
					pids,
					Array.map((pid) => `,${String(pid)}`),
					Array.join(""),
				);

				const handle = yield* spawner.spawn(ChildProcess.make("/bin/sh", ["-c", listing, "ps", listed], psOptions));
				const printed = yield* Stream.mkString(Stream.decodeText(handle.stdout));
				const exitCode = yield* handle.exitCode;

				return pipe(
					provenRows(printed, exitCode, Number(handle.pid)),
					Option.map(Array.filter(({ pid, zombie }) => !zombie && Array.contains(pids, pid))),
				);
			}, Effect.scoped);

			const running = (pids: readonly (typeof Pid.Type)[]): Effect.Effect<Option.Option<readonly LiveProcess[]>> =>
				read(pids).pipe(
					Effect.timeout(psPatience),
					Effect.catchCause(() => Effect.succeedNone),
				);

			const launched = Effect.fnUntraced(function* launched([command, ...args]: readonly [string, ...string[]]) {
				const options = { detached: true, stderr: "ignore", stdin: "ignore", stdout: "ignore" } as const;
				const handle = yield* spawner.spawn(ChildProcess.make(command, args, options));

				yield* Effect.asVoid(handle.unref);

				const ended = handle.isRunning.pipe(Effect.map((alive) => !alive));

				const exited = Effect.when(handle.exitCode.pipe(Effect.map(Number)), ended).pipe(
					Effect.orElseSucceed(Option.none<number>),
				);

				return { exited };
			});

			return Processes.of({ launched, running });
		}),
	);
}

export { Processes, Started, realFolder };

export type { LiveProcess };
