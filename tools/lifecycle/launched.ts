import {
	Array,
	Clock,
	Config,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Predicate,
	Record,
	Schedule,
	Schema,
	String as Str,
	Stream,
	Struct,
	pipe,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientRequest, HttpServer } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import { mocked } from "#tools/route/mocked-router.ts";

const ran = Effect.fnUntraced(function* ran(
	command: readonly [string, ...string[]],
	env: Readonly<Record<string, string>>,
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const [runtime, ...args] = command;
	const handle = yield* spawner.spawn(ChildProcess.make(runtime, args, { env, extendEnv: true }));
	const printed = yield* Stream.mkString(Stream.decodeText(Stream.merge(handle.stdout, handle.stderr)));
	const exitCode = yield* handle.exitCode;

	return { exitCode: Number(exitCode), printed };
}, Effect.scoped);

const bundled = Effect.fnUntraced(function* bundled(version?: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-bundle-" });
	const entry = path.join(folder, "phi-router.mjs");
	const source = path.resolve(import.meta.dirname, "../../src/router/main.ts");

	yield* ran(["bun", "build", source, "--target", "node", "--outfile", entry], {});

	if (Predicate.isNotUndefined(version)) {
		yield* fs.makeDirectory(path.join(folder, ".claude-plugin"));
		yield* fs.writeFileString(path.join(folder, ".claude-plugin", "plugin.json"), `{"version":"${version}"}`);
	}

	return entry;
});

const belowHeld = 30_000;

const badPorts: ReadonlySet<string> = new Set(
	Str.split(
		"1 7 9 11 13 15 17 19 20 21 22 23 25 37 42 43 53 69 77 79 87 95 101 102 103 104 109 110 111 113 115 117 119 123 135 137 139 143 161 179 389 427 465 512 513 514 515 526 530 531 532 540 548 554 556 563 587 601 636 989 990 993 995 1719 1720 1723 2049 3659 4045 4190 5060 5061 6000 6566 6665 6666 6667 6668 6669 6679 6697 10080",
		" ",
	),
);

const portBelow = (held: number): Option.Option<number> =>
	Option.filter(Option.some(held - belowHeld), (port) => !badPorts.has(String(port)));

const freePort = Effect.gen(function* freePort() {
	const built = yield* Layer.build(NodeHttpServer.layerTest);
	const { address } = Context.get(built, HttpServer.HttpServer);
	const held = yield* pipe(HttpServer.formatAddress(address), Str.split(":"), Array.last, Effect.fromOption);

	return portBelow(Number(held));
}).pipe(Effect.repeat({ until: Option.isSome }), Effect.flatMap(Effect.fromOption));

const instance = Effect.fnUntraced(function* instance() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const handle = yield* spawner.spawn(ChildProcess.make("node", ["-e", "setTimeout(() => {}, 300_000)"]));

	return { end: handle.kill({ killSignal: "SIGKILL" }), pid: Number(handle.pid) };
});

const onWindows = process.platform === "win32";

interface Pattern {
	readonly posix: string;
	readonly windows: string;
}

const likeLiteral = (text: string): string => Str.replaceAll(/[`*?[\]]/gu, "`$&")(text);

const serving = (entry: string, port: number): Pattern => {
	const command = `${entry} serve --port ${String(port)}`;

	return { posix: `${command}$`, windows: `*${likeLiteral(command)}` };
};

const listing = (pattern: Pattern): readonly [string, ...string[]] => {
	if (onWindows) {
		const query = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '${Str.replaceAll("'", "''")(pattern.windows)}' -and $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId }`;

		return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", query];
	}

	return ["pgrep", "-f", pattern.posix];
};

const pidsOf = Effect.fnUntraced(function* pidsOf(pattern: Pattern) {
	const { printed } = yield* ran(listing(pattern), {});

	return pipe(Str.split(Str.trim(printed), /\r?\n/u), Array.filter(Str.isNonEmpty));
});

const routersOn = Effect.fnUntraced(function* routersOn(entry: string, port: number) {
	const pids = yield* pidsOf(serving(entry, port));

	return pipe(pids, Array.map(Number));
});

const windowsBasicNames = ["APPDATA", "ComSpec", "LOCALAPPDATA", "PATHEXT", "SystemRoot", "TEMP", "TMP", "USERPROFILE"];

const basicOf = (name: string): Effect.Effect<readonly (readonly [string, string])[]> =>
	Config.String(name).pipe(
		Effect.map((value) => [[name, value] as const]),
		Effect.orElseSucceed(() => []),
	);

const windowsBasics = Effect.gen(function* windowsBasics() {
	if (!onWindows) {
		return {};
	}

	const found = yield* Effect.forEach(windowsBasicNames, basicOf, { concurrency: 1 });

	return Record.fromEntries(Array.flatten(found));
});

const stopped = Effect.fnUntraced(function* stopped(pattern: Pattern) {
	if (!onWindows) {
		return yield* ran(["pkill", "-9", "-f", pattern.posix], {});
	}

	const pids = yield* pidsOf(pattern);

	const named = pipe(
		pids,
		Array.flatMap((pid) => ["/PID", pid]),
	);

	return yield* ran(["taskkill.exe", "/F", ...named], {});
});

const stopMatching = (fragment: string): ReturnType<typeof stopped> =>
	stopped({ posix: fragment, windows: `*${likeLiteral(fragment)}*` });

const killedHard = (pid: number): ReturnType<typeof ran> => {
	if (onWindows) {
		return ran(["taskkill.exe", "/F", "/PID", String(pid)], {});
	}

	return ran(["kill", "-9", String(pid)], {});
};

const answers = Effect.fnUntraced(function* answers(port: number) {
	const client = yield* HttpClient.HttpClient;

	return yield* client.execute(HttpClientRequest.head(`http://127.0.0.1:${String(port)}/api/hello`)).pipe(
		Effect.as(true),
		Effect.orElseSucceed(() => false),
	);
});

const StoredLease = Schema.Struct({ folder: Schema.String, pid: Schema.Finite, session: Schema.String });

const Stored = Schema.fromJsonString(Schema.Struct({ leases: Schema.Array(StoredLease) }));

const leasesIn = Effect.fnUntraced(function* leasesIn(state: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const text = yield* fs.readFileString(path.join(state, "leases.json"));
	const stored = yield* Schema.decodeEffect(Stored)(text);

	return stored.leases;
});

const leasedPids = Effect.fnUntraced(function* leasedPids(state: string) {
	const leases = yield* leasesIn(state);

	return pipe(
		leases,
		Array.map(({ pid }) => pid),
	);
});

const refusedWithin = Effect.fnUntraced(function* refusedWithin(port: number, limit: number) {
	const started = yield* Clock.currentTimeMillis;

	yield* answers(port).pipe(
		Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (open) => !open }),
		Effect.timeoutOption(limit),
		Effect.flatMap(
			Option.match({ onNone: () => Effect.die(`port ${String(port)} still answers`), onSome: Effect.succeed }),
		),
	);

	const refused = yield* Clock.currentTimeMillis;

	return refused - started;
});

const world = Effect.fnUntraced(function* world(entry: string, more: Readonly<Record<string, string>> = {}) {
	const fs = yield* FileSystem.FileSystem;
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-home-" });
	const { env: mockEnv, mocks, state } = yield* mocked({ holdsPhi: () => false });
	const env = Struct.assign(Struct.assign(mockEnv, { HOME: home }), more);
	const port = yield* freePort;

	yield* Effect.addFinalizer(() => stopped(serving(entry, port)).pipe(Effect.orDie));

	const start = (pid: number, from = entry): ReturnType<typeof ran> =>
		ran(
			["node", from, "start", "--pid", String(pid), "--session", "s1", "--folder", "/work", "--port", String(port)],
			env,
		);

	return { env, home, mocks, port, routers: routersOn(entry, port), start, state };
});

export {
	answers,
	badPorts,
	bundled,
	freePort,
	instance,
	killedHard,
	leasedPids,
	leasesIn,
	portBelow,
	ran,
	refusedWithin,
	routersOn,
	stopMatching,
	windowsBasics,
	world,
};
