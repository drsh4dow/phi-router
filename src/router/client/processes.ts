import {
	Array,
	Context,
	DateTime,
	Effect,
	Equal,
	FileSystem,
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
import { forPlatform } from "./platform.ts";

const Started = Schema.NonEmptyString;

interface LiveProcess {
	readonly pid: number;
	readonly started: typeof Started.Type;
}

interface PsRow extends LiveProcess {
	readonly zombie: boolean;
}

const psPatience = "2 seconds";

const listing = 'exec ps -o pid=,stat=,lstart= -p "$$$1"';

const psOptions = {
	env: { LC_ALL: "C", TZ: "UTC" },
	extendEnv: true,
	forceKillAfter: "1 second",
	stderr: "ignore",
} as const;

const monthsByNumber = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const rowPattern =
	/^(?<pid>\d+) +(?<state>\S+) +(?<started>(?<weekday>[A-Z][a-z]{2}) (?<month>[A-Z][a-z]{2}) +(?<day>\d{1,2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) (?<year>\d{4}))$/u;

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

const instantPattern =
	/^(?<pid>\d+) (?<started>(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})\.\d{7}Z)$/u;

const isRealInstant = (started: Readonly<Record<string, string>>): boolean => {
	const { day = "", hour = "", minute = "", month = "", second = "", year = "" } = started;

	const parts = {
		day: Number(day),
		hour: Number(hour),
		millisecond: 0,
		minute: Number(minute),
		month: Number(month),
		second: Number(second),
		year: Number(year),
	};

	return pipe(
		DateTime.make(parts),
		Option.map(DateTime.toPartsUtc),
		Option.exists((made) => Equal.equals(made, Struct.assign(parts, { weekDay: made.weekDay }))),
	);
};

const succeeded = 0;

const resolving = 'cd -P -- "$1" && pwd -P';

const shellRealFolder = (folder: string): Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner> =>
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

const nativeRealFolder = (folder: string): Effect.Effect<string> =>
	Effect.serviceOption(FileSystem.FileSystem).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.succeed(folder),
				onSome: (fs) => fs.realPath(folder),
			}),
		),
		Effect.orElseSucceed(() => folder),
	);

const realFolder = (folder: string): Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner> =>
	forPlatform({ posix: shellRealFolder(folder), windows: nativeRealFolder(folder) }).pipe(Effect.flatten);

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

const instantRowOf = (line: string): Option.Option<PsRow> =>
	pipe(
		Option.fromNullishOr(instantPattern.exec(line)),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
		Option.filter(isRealInstant),
		Option.map(({ pid = "", started = "" }) => ({ pid: Number(pid), started, zombie: false })),
	);

interface Listing {
	readonly command: (pids: readonly number[]) => ChildProcess.Command;
	readonly lines: (printed: string) => readonly string[];
	readonly rowOf: (line: string) => Option.Option<PsRow>;
}

const psListing: Listing = {
	command: (pids) => {
		const listed = pipe(
			pids,
			Array.map((pid) => `,${String(pid)}`),
			Array.join(""),
		);

		return ChildProcess.make("/bin/sh", ["-c", listing, "ps", listed], psOptions);
	},
	lines: (printed) => pipe(printed, Str.replace(/\n$/u, ""), Str.split("\n")),
	rowOf,
};

const cimFlags = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] as const;

const cimScript = (pids: readonly number[]): string => {
	const others = pipe(
		pids,
		Array.map((pid) => ` OR ProcessId=${String(pid)}`),
		Array.join(""),
	);

	const filter = `('ProcessId=' + $PID + '${others}')`;
	const row = "'{0} {1}' -f $_.ProcessId, $_.CreationDate.ToUniversalTime().ToString('o')";

	return `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter ${filter} | ForEach-Object { ${row} }`;
};

const cimOptions = { forceKillAfter: "1 second", stderr: "ignore", stdin: "ignore" } as const;

const cimListing: Listing = {
	command: (pids) => ChildProcess.make("powershell.exe", [...cimFlags, cimScript(pids)], cimOptions),
	lines: (printed) => pipe(printed, Str.replace(/\r?\n$/u, ""), Str.split(/\r?\n/u)),
	rowOf: instantRowOf,
};

const provenRows =
	(from: Listing) =>
	(printed: string, exitCode: number, self: number): Option.Option<readonly PsRow[]> => {
		if (exitCode !== succeeded) {
			return Option.none();
		}

		return pipe(
			from.lines(printed),
			Array.map(from.rowOf),
			Option.all,
			Option.filter(Array.some(({ pid }) => pid === self)),
		);
	};

class Processes extends Context.Service<
	Processes,
	{
		readonly running: (pids: readonly (typeof Pid.Type)[]) => Effect.Effect<Option.Option<readonly LiveProcess[]>>;
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
			const from = yield* forPlatform({ posix: psListing, windows: cimListing });

			const read = Effect.fnUntraced(function* read(pids: readonly (typeof Pid.Type)[]) {
				const handle = yield* spawner.spawn(from.command(pids));
				const printed = yield* Stream.mkString(Stream.decodeText(handle.stdout));
				const exitCode = yield* handle.exitCode;

				return pipe(
					provenRows(from)(printed, exitCode, Number(handle.pid)),
					Option.map(Array.filter(({ pid, zombie }) => !zombie && Array.contains(pids, pid))),
				);
			}, Effect.scoped);

			const running = (pids: readonly (typeof Pid.Type)[]): Effect.Effect<Option.Option<readonly LiveProcess[]>> =>
				read(pids).pipe(
					Effect.timeout(psPatience),
					Effect.catchCause(() => Effect.succeedNone),
				);

			const launched = Effect.fnUntraced(function* launched([command, ...args]: readonly [string, ...string[]]) {
				const options = {
					detached: true,
					stderr: "ignore",
					stdin: "ignore",
					stdout: "ignore",
					windowsHide: true,
				} as const;

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
