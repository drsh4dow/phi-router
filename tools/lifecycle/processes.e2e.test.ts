import {
	Array,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	PlatformError,
	Sink,
	String as Str,
	Stream,
	Struct,
	pipe,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Processes, realFolder } from "#router/client/processes.ts";
import { assert, it } from "@effect/vitest";
import type { LiveProcess } from "#router/client/processes.ts";
import { NodeServices } from "@effect/platform-node";
import { TestClock } from "effect/testing";

const zombieMaker = ChildProcess.make("sh", ["-c", "sleep 0.1 & echo $!; exec sleep 30"]);

const endedPid = Effect.fnUntraced(function* endedPid() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const done = yield* spawner.spawn(ChildProcess.make("true"));

	yield* done.exitCode;

	return Number(done.pid);
});

const zombieAndParent = Effect.fnUntraced(function* zombieAndParent() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const shell = yield* spawner.spawn(zombieMaker);

	const printed = yield* shell.stdout.pipe(
		Stream.decodeText,
		Stream.splitLines,
		Stream.runHead,
		Effect.flatMap(Effect.fromOption),
	);

	yield* TestClock.withLive(Effect.sleep("500 millis"));

	return { alive: Number(shell.pid), zombie: Number(Str.trim(printed)) };
});

const pidsOf = Array.map(({ pid }: LiveProcess) => pid);

it.layer(Layer.provideMerge(Processes.layer, NodeServices.layer))("the processes of this machine", (test) => {
	test.effect("a running pid reads the same start time twice, and a pid that ended or is a zombie is absent", () =>
		Effect.gen(function* running() {
			const processes = yield* Processes;
			const ended = yield* endedPid();
			const { alive, zombie } = yield* zombieAndParent();
			const first = yield* processes.running([alive, ended, zombie]);
			const again = yield* processes.running([alive]);

			assert.deepStrictEqual(pipe(first, Option.map(pidsOf)), Option.some([alive]));
			assert.deepStrictEqual(again, first);
		}).pipe(Effect.scoped),
	);
});

const init = 1;

const pastArgMax = 400_000;

it.layer(Layer.provideMerge(Processes.layer, NodeServices.layer))("a ps that could not be spawned", (test) => {
	test.effect("reads nothing when its pids pass ARG_MAX, so no lease is dropped", () =>
		Effect.gen(function* unspawned() {
			const processes = yield* Processes;
			const read = yield* processes.running(Array.makeBy(pastArgMax, (index) => index + init));

			assert.isTrue(Option.isNone(read));
		}),
	);
});

const psPid = 4242;

const leasedPid = 42;

const started = "Sat Nov 21 10:45:11 2026";

const rows = {
	leased: `   42 Ss   ${started}`,
	ps: `4242 R+   ${started}`,
	weekdayOff: "   42 Ss   Fri Nov 21 10:45:11 2026",
} as const;

const listedExit = 0;

const printing = (printed: string, exitCode: number): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> => {
	const exited = Effect.succeed(ChildProcessSpawner.ExitCode(exitCode));
	const stdout = Stream.make(new TextEncoder().encode(printed));

	const ps = ChildProcessSpawner.makeHandle({
		all: Stream.empty,
		exitCode: exited,
		getInputFd: () => Sink.drain,
		getOutputFd: () => Stream.empty,
		isRunning: Effect.succeed(false),
		kill: () => Effect.void,
		pid: ChildProcessSpawner.ProcessId(psPid),
		stderr: Stream.empty,
		stdin: Sink.drain,
		stdout,
		unref: Effect.die("a read never unrefs ps"),
	});

	return Layer.succeed(
		ChildProcessSpawner.ChildProcessSpawner,
		ChildProcessSpawner.make(() => Effect.succeed(ps)),
	);
};

const callerSpawner = (env: Readonly<Record<string, string>>): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.effect(
		ChildProcessSpawner.ChildProcessSpawner,
		Effect.gen(function* wrapped() {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

			return ChildProcessSpawner.make((command) => {
				if (!ChildProcess.isStandardCommand(command)) {
					return spawner.spawn(command);
				}

				const options = Struct.assign(command.options, { env: Struct.assign(env, command.options.env ?? {}) });

				return spawner.spawn(ChildProcess.make(command.command, command.args, options));
			});
		}),
	).pipe(Layer.provide(NodeServices.layer));

const underCaller = (env: Readonly<Record<string, string>>): Layer.Layer<Processes> =>
	Layer.provide(Processes.layer, callerSpawner(env));

const startsOf = Option.map(Array.map(({ pid, started: at }: LiveProcess) => [pid, at] as const));

const printedRead = Effect.fnUntraced(function* printedRead(printed: readonly string[], exitCode: number) {
	const text = `${Array.join(printed, "\n")}\n`;
	const built = yield* Layer.build(Layer.provide(Processes.layer, printing(text, exitCode)));
	const read = yield* Context.get(built, Processes).running([leasedPid]);

	return startsOf(read);
}, Effect.scoped);

const callerRead = Effect.fnUntraced(function* callerRead(
	env: Readonly<Record<string, string>>,
	pids: readonly number[],
) {
	const built = yield* Layer.build(underCaller(env));

	return yield* Context.get(built, Processes).running(pids);
}, Effect.scoped);

const weekdayChecked = Effect.gen(function* weekdayChecked() {
	const reads = yield* Effect.all(
		{
			listed: printedRead([rows.ps, rows.leased], listedExit),
			weekdayOff: printedRead([rows.ps, rows.weekdayOff], listedExit),
		},
		{ concurrency: 1 },
	);

	assert.deepStrictEqual(reads, {
		listed: Option.some([[leasedPid, started] as const]),
		weekdayOff: Option.none(),
	});
});

const zones = ["Pacific/Kiritimati", "Pacific/Pago_Pago"] as const;

const anyZone = Effect.gen(function* anyZone() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const sleeping = yield* spawner.spawn(ChildProcess.make("sleep", ["30"]));
	const pids = [Number(sleeping.pid)];

	const [east, west] = yield* Effect.forEach(zones, (zone) => callerRead({ LANG: "C", TZ: zone }, pids), {
		concurrency: 1,
	});

	assert.isTrue(Option.isSome(east));
	assert.deepStrictEqual(west, east);
}).pipe(Effect.scoped);

const stubbornPs = "#!/bin/sh\ntrap '' TERM\nexec sleep 300\n";

const runnable = 0o755;

const stubborn = Effect.gen(function* stubborn() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const bin = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-ps-" });

	yield* fs.writeFileString(path.join(bin, "ps"), stubbornPs, { mode: runnable });

	const read = yield* TestClock.withLive(callerRead({ PATH: `${bin}:/usr/bin:/bin` }, [init]));

	assert.isTrue(Option.isNone(read));
}).pipe(Effect.scoped);

const noShell = Layer.succeed(
	ChildProcessSpawner.ChildProcessSpawner,
	ChildProcessSpawner.make(() =>
		Effect.fail(PlatformError.badArgument({ description: "no shell", method: "spawn", module: "ChildProcess" })),
	),
);

const asTyped = Effect.gen(function* asTyped() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-cdpath-" });
	const missing = path.join(elsewhere, "missing");

	yield* fs.makeDirectory(path.join(elsewhere, "tools"));

	const underCdpath = yield* Layer.build(callerSpawner({ CDPATH: elsewhere }));
	const unspawned = yield* Layer.build(noShell);

	const resolved = yield* Effect.all(
		{
			missing: Effect.provideContext(realFolder(missing), underCdpath),
			relative: Effect.provideContext(realFolder("tools"), underCdpath),
			unspawned: Effect.provideContext(realFolder("tools"), unspawned),
		},
		{ concurrency: 1 },
	);

	assert.deepStrictEqual(resolved, { missing, relative: path.resolve("tools"), unspawned: "tools" });
}).pipe(Effect.scoped);

const patient = { timeout: 30_000 };

it.layer(NodeServices.layer)("what ps printed", (test) => {
	test.effect("reads a row whose weekday fits its date, and nothing when a weekday does not", () => weekdayChecked);
	test.effect("a running pid reads the same start time whatever the caller's time zone", () => anyZone);
	test.effect("a ps that never answers and ignores SIGTERM is killed, and reads nothing", () => stubborn, patient);
	test.effect(
		"realFolder resolves a relative folder against the working folder whatever CDPATH holds, and gives one it cannot resolve as typed",
		() => asTyped,
	);
});
