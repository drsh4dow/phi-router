import {
	Array,
	Context,
	Effect,
	Fiber,
	FileSystem,
	Latch,
	Layer,
	Path,
	Record,
	Ref,
	Sink,
	String as Str,
	Stream,
	Struct,
	pipe,
} from "effect";
import type { Caller, Connection } from "#router/client/router-port/index.ts";
import { Callers, serve, unnamed } from "#router/client/router-port/index.ts";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientRequest } from "effect/http";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { TestClock } from "effect/testing";

const connection: Connection = {
	caller: "127.0.0.1:33414",
	router: "127.0.0.1:56717",
};

const heading = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

const rows = {
	anotherAddress:
		"   3: 0200007F:8286 0100007F:DD8D 01 00000000:00000000 00:00000000 00000000  1000        0 49675693 1 00000000f548b403 20 4 30 10 -1",
	anotherUser:
		"   3: 0100007F:8286 0100007F:DD8D 01 00000000:00000000 00:00000000 00000000  4242        0 49675693 1 00000000f548b403 20 4 30 10 -1",
	closed:
		"   3: 0100007F:8286 0100007F:DD8D 06 00000000:00000000 03:00000354 00000000     0        0 0 3 000000000662151b",
	listening:
		"   1: 0100007F:DD8D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 49675691 1 00000000f548b401 100 0 0 10 0",
	routerEnd:
		"   2: 0100007F:DD8D 0100007F:8286 01 00000000:00000000 00:00000000 00000000  1000        0 49675692 1 00000000f548b402 20 4 30 10 -1",
	thisUser:
		"   3: 0100007F:8286 0100007F:DD8D 01 00000000:00000000 00:00000000 00000000  1000        0 49675693 1 00000000f548b403 20 4 30 10 -1",
};

const answerFor = Effect.fnUntraced(function* answerFor(callerRows: readonly string[], asked: Caller = connection) {
	const text = Array.join([heading, rows.listening, rows.routerEnd, ...callerRows, ""], "\n");

	const table = FileSystem.layerNoop({
		exists: () => Effect.succeed(true),
		readFileString: () => Effect.succeed(text),
	});

	const built = yield* Layer.build(Callers.layer.pipe(Layer.provide(table)));

	return yield* Context.get(built, Callers).isThisUser(asked);
});

const unreadable = Effect.gen(function* unreadable() {
	const table = FileSystem.layerNoop({ exists: () => Effect.succeed(true) });
	const built = yield* Layer.build(Callers.layer.pipe(Layer.provide(table)));

	return yield* Context.get(built, Callers).isThisUser(connection);
});

const exits = { failed: 1, listed: 0 } as const;

const childPid = 4321;

const lsofPrinted = "p1\nu1000\nn127.0.0.1:33414->127.0.0.1:56717\np2\nu1000\nn127.0.0.1:56717->127.0.0.1:33414\n";

const lsofPrintedForAnotherUsersCaller =
	"p1\nu4242\nn127.0.0.1:33414->127.0.0.1:56717\np2\nu1000\nn127.0.0.1:56717->127.0.0.1:33414\n";

const exitsWith = (exitCode: number): Effect.Effect<ChildProcessSpawner.ExitCode> =>
	Effect.succeed(ChildProcessSpawner.ExitCode(exitCode));

interface Printed {
	readonly printed: string;
	readonly exitCode: () => Effect.Effect<ChildProcessSpawner.ExitCode>;
}

const childPrinting = ({ printed, exitCode }: Printed): ChildProcessSpawner.ChildProcessHandle =>
	ChildProcessSpawner.makeHandle({
		all: Stream.empty,
		exitCode: exitCode(),
		getInputFd: () => Sink.drain,
		getOutputFd: () => Stream.empty,
		isRunning: Effect.succeed(false),
		kill: () => Effect.void,
		pid: ChildProcessSpawner.ProcessId(childPid),
		stderr: Stream.empty,
		stdin: Sink.drain,
		stdout: Stream.make(new TextEncoder().encode(printed)),
		unref: Effect.die("the check never unrefs"),
	});

const noProcTable = FileSystem.layerNoop({ exists: () => Effect.succeed(false) });

const lsofAnswerFor = Effect.fnUntraced(function* lsofAnswerFor(
	printed: string,
	exitCode: () => Effect.Effect<ChildProcessSpawner.ExitCode>,
) {
	const spawner = Layer.succeed(
		ChildProcessSpawner.ChildProcessSpawner,
		ChildProcessSpawner.make(() => Effect.succeed(childPrinting({ exitCode, printed }))),
	);

	const built = yield* Layer.build(Callers.layer.pipe(Layer.provide([noProcTable, spawner, Path.layer])));

	return yield* Context.get(built, Callers).isThisUser(connection);
});

const windowsSeparator = { sep: "\\" } as const;

const windowsPath = Layer.effect(
	Path.Path,
	Effect.gen(function* windowsPath() {
		const posix = yield* Path.Path;

		return Path.make(Struct.assign(posix, windowsSeparator));
	}),
).pipe(Layer.provide(Path.layer));

const netstatOf = (lines: readonly string[]): string =>
	Array.join(
		[
			"",
			"Active Connections",
			"",
			"  Proto  Local Address          Foreign Address        State           PID",
			"  TCP    127.0.0.1:56717        0.0.0.0:0              LISTENING       5100",
			...lines,
			"",
		],
		"\r\n",
	);

const netstatLines = {
	callerEnd: "  TCP    127.0.0.1:33414        127.0.0.1:56717        ESTABLISHED     6200",
	closedCallerEnd: "  TCP    127.0.0.1:33414        127.0.0.1:56717        TIME_WAIT       0",
	routerEnd: "  TCP    127.0.0.1:56717        127.0.0.1:33414        ESTABLISHED     5100",
};

const pids = { caller: 6200, router: 5100 } as const;

const tasklistOf = (pid: number, owner: string): string =>
	`"node.exe","${pid}","Console","1","42,604 K","Unknown","${owner}","0:00:00","N/A"\r\n`;

const noTask = "INFO: No tasks are running which match the specified criteria.\r\n";

const owners = {
	another: String.raw`DESKTOP-TEST\other`,
	system: String.raw`NT AUTHORITY\SYSTEM`,
	undecoded: `${String.raw`DESKTOP-TEST\Jos`}�`,
	unreadable: "N/A",
	user: String.raw`DESKTOP-TEST\dev`,
} as const;

const listed = (printed: string): Printed => ({ exitCode: () => exitsWith(exits.listed), printed });

const failed = (printed: string): Printed => ({ exitCode: () => exitsWith(exits.failed), printed });

interface Tasks {
	readonly caller: Printed;
	readonly router: Printed;
}

interface Windows {
	readonly netstat: Printed;
	readonly tasks: Tasks;
}

const tasksOf = (callerOwner: string, routerOwner: string = owners.user): Tasks => ({
	caller: listed(tasklistOf(pids.caller, callerOwner)),
	router: listed(tasklistOf(pids.router, routerOwner)),
});

const netstats = {
	closedCallerEnd: listed(netstatOf([netstatLines.routerEnd, netstatLines.closedCallerEnd])),
	healthy: listed(netstatOf([netstatLines.routerEnd, netstatLines.callerEnd])),
	noCallerEnd: listed(netstatOf([netstatLines.routerEnd])),
};

const healthyNetstat = netstats.healthy;

const callerTasks = {
	failed: failed(tasklistOf(pids.caller, owners.user)),
	missing: listed(noTask),
	routerPid: listed(tasklistOf(pids.router, owners.user)),
	twoRows: listed(`${tasklistOf(pids.caller, owners.user)}${tasklistOf(pids.caller, owners.another)}`),
};

const idleProcess = 0;

const healthy: Windows = { netstat: healthyNetstat, tasks: tasksOf(owners.user) };

const answerOf = (windows: Windows, args: string): Printed => {
	if (Str.endsWith("-ano -p TCP")(args)) {
		return windows.netstat;
	}

	if (Str.endsWith(`PID eq ${pids.caller}`)(args)) {
		return windows.tasks.caller;
	}

	if (Str.endsWith(`PID eq ${pids.router}`)(args)) {
		return windows.tasks.router;
	}

	if (Str.endsWith(`PID eq ${idleProcess}`)(args)) {
		return listed(tasklistOf(idleProcess, owners.system));
	}

	return listed(noTask);
};

const windowsAnswerFor = Effect.fnUntraced(function* windowsAnswerFor(windows: Windows, asked: Caller = connection) {
	const spawned = yield* Ref.make<readonly string[]>([]);

	const spawner = Layer.succeed(
		ChildProcessSpawner.ChildProcessSpawner,
		ChildProcessSpawner.make((command) => {
			if (!ChildProcess.isStandardCommand(command)) {
				return Effect.die("the check runs no pipeline");
			}

			const args = pipe(command.args, Array.map(String), Array.join(" "));
			const answer = childPrinting(answerOf(windows, args));

			return Effect.as(Ref.update(spawned, Array.append(`${command.command} ${args}`)), answer);
		}),
	);

	const built = yield* Layer.build(Callers.layer.pipe(Layer.provide([noProcTable, spawner, windowsPath])));
	const answered = yield* Context.get(built, Callers).isThisUser(asked);
	const commands = yield* Ref.get(spawned);

	return { answered, commands: Array.join(commands, "\n") };
});

const endpointOf = (host: string, port: number): Connection["caller"] => `${host}:${port}`;

const ipv6Connection: Connection = {
	caller: endpointOf("::1", pids.caller),
	router: endpointOf("::1", pids.router),
};

const windowsAnswers = Effect.gen(function* windowsAnswers() {
	const answered = yield* Effect.all(
		{
			anotherUser: windowsAnswerFor({ netstat: healthyNetstat, tasks: tasksOf(owners.another) }),
			closedCallerEnd: windowsAnswerFor({
				netstat: netstats.closedCallerEnd,
				tasks: tasksOf(owners.system, owners.system),
			}),
			ipv6Caller: windowsAnswerFor(healthy, ipv6Connection),
			missingCallerRow: windowsAnswerFor({
				netstat: netstats.noCallerEnd,
				tasks: healthy.tasks,
			}),
			missingTask: windowsAnswerFor({
				netstat: healthyNetstat,
				tasks: { caller: callerTasks.missing, router: healthy.tasks.router },
			}),
			netstatFailed: windowsAnswerFor({ netstat: failed(healthyNetstat.printed), tasks: healthy.tasks }),
			sameUser: windowsAnswerFor(healthy),
			tasklistFailed: windowsAnswerFor({
				netstat: healthyNetstat,
				tasks: { caller: callerTasks.failed, router: healthy.tasks.router },
			}),
			twoRows: windowsAnswerFor({
				netstat: healthyNetstat,
				tasks: { caller: callerTasks.twoRows, router: healthy.tasks.router },
			}),
			undecodedOwner: windowsAnswerFor({
				netstat: healthyNetstat,
				tasks: tasksOf(owners.undecoded, owners.undecoded),
			}),
			unreadableOwner: windowsAnswerFor({ netstat: healthyNetstat, tasks: tasksOf(owners.unreadable) }),
			unreadableOwners: windowsAnswerFor({
				netstat: healthyNetstat,
				tasks: tasksOf(owners.unreadable, owners.unreadable),
			}),
			wrongPidRow: windowsAnswerFor({
				netstat: healthyNetstat,
				tasks: { caller: callerTasks.routerPid, router: healthy.tasks.router },
			}),
		},
		{ concurrency: 1 },
	);

	assert.deepStrictEqual(
		{
			answers: pipe(
				answered,
				Record.map(({ answered: given }) => given),
			),
			commands: answered.sameUser.commands,
		},
		{
			answers: {
				anotherUser: false,
				closedCallerEnd: false,
				ipv6Caller: false,
				missingCallerRow: false,
				missingTask: false,
				netstatFailed: false,
				sameUser: true,
				tasklistFailed: false,
				twoRows: false,
				undecodedOwner: false,
				unreadableOwner: false,
				unreadableOwners: false,
				wrongPidRow: false,
			},
			commands: Array.join(
				[
					String.raw`C:\Windows/System32/netstat.exe -ano -p TCP`,
					String.raw`C:\Windows/System32/tasklist.exe /v /fo csv /nh /fi PID eq 5100`,
					String.raw`C:\Windows/System32/tasklist.exe /v /fo csv /nh /fi PID eq 6200`,
				],
				"\n",
			),
		},
	);
});

const answers = Effect.gen(function* answers() {
	const answered = yield* Effect.all(
		{
			anotherAddress: answerFor([rows.anotherAddress]),
			anotherUser: answerFor([rows.anotherUser]),
			closed: answerFor([rows.closed]),
			lsofAnotherUser: lsofAnswerFor(lsofPrintedForAnotherUsersCaller, () => exitsWith(exits.listed)),
			lsofFailed: lsofAnswerFor(lsofPrinted, () => exitsWith(exits.failed)),
			lsofThisUser: lsofAnswerFor(lsofPrinted, () => exitsWith(exits.listed)),
			noCallerEnd: answerFor([]),
			noSocketEnds: answerFor([rows.thisUser], unnamed),
			thisUser: answerFor([rows.thisUser]),
			unreadable,
		},
		{ concurrency: 1 },
	);

	assert.deepStrictEqual(answered, {
		anotherAddress: false,
		anotherUser: false,
		closed: false,
		lsofAnotherUser: false,
		lsofFailed: false,
		lsofThisUser: true,
		noCallerEnd: false,
		noSocketEnds: false,
		thisUser: true,
		unreadable: false,
	});
});

const slowLsof = Effect.gen(function* slowLsof() {
	const awaited = yield* Latch.make();

	const checking = yield* Effect.forkChild(
		lsofAnswerFor(lsofPrinted, () => Effect.andThen(awaited.open, Effect.never)),
	);

	yield* awaited.await;
	yield* TestClock.adjust("2 seconds");

	const answered = yield* Fiber.join(checking);

	assert.isFalse(answered);
});

const slowTasklist = Effect.gen(function* slowTasklist() {
	const awaited = yield* Latch.make();
	const hangs: Printed = { exitCode: () => Effect.andThen(awaited.open, Effect.never), printed: "" };

	const checking = yield* Effect.forkChild(
		windowsAnswerFor({ netstat: healthyNetstat, tasks: { caller: hangs, router: healthy.tasks.router } }),
	);

	yield* awaited.await;
	yield* TestClock.adjust("2 seconds");

	const { answered } = yield* Fiber.join(checking);

	assert.isFalse(answered);
});

const notFound = 404;

const realConnection = Effect.gen(function* realConnection() {
	const server = yield* Layer.build(NodeHttpServer.layerTest);

	const served = serve([]).pipe(Layer.provide(Callers.layer), Layer.provide(Layer.succeedContext(server)));

	yield* Layer.build(served);

	const response = yield* Context.get(server, HttpClient.HttpClient).execute(
		HttpClientRequest.get("/phi-router/no-such-row"),
	);

	assert.strictEqual(response.status, notFound);
});

it.layer(NodeServices.layer)("the caller check", (test) => {
	test.effect(
		"passes a caller whose end this user holds, and refuses another user's end, a missing end, a closed end, an end at another address, a table it cannot read, an lsof that failed and an lsof that gives the caller's process another uid",
		() => answers,
	);
	test.effect("refuses a caller once lsof has not exited within 2 seconds", () => slowLsof);
	test.effect(
		"on Windows passes a caller whose process the router's account owns, by netstat and tasklist from System32, and refuses another account's process, an owner tasklist cannot read or decode, a missing row or task, two tasks for one process, a closed end, an IPv6 caller and a netstat or tasklist that failed",
		() => windowsAnswers,
	);
	test.effect("on Windows refuses a caller once tasklist has not exited within 2 seconds", () => slowTasklist);
	test.effect(
		"lets a real loopback connection of this process through to the path table, which answers 404",
		() => realConnection,
	);
});
