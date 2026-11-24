import { Array, Context, Effect, Fiber, FileSystem, Latch, Layer, Sink, Stream } from "effect";
import type { Caller, Connection } from "#router/client/router-port/index.ts";
import { Callers, unnamed } from "#router/client/router-port/index.ts";
import { assert, it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/process";
import { NodeServices } from "@effect/platform-node";
import { TestClock } from "effect/testing";

/** One connection to the router, in `/proc/net/tcp` as `0100007F:DD8D` and `0100007F:8286`. */
const connection: Connection = {
	caller: "127.0.0.1:33414",
	router: "127.0.0.1:56717",
};

const heading = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

/**
 * Rows in the kernel's layout. The router's ends and the caller's end at uid 4242 are the rows a request from a
 * container run with `--network host --user 4242:4242` left on this machine.
 */
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

/** What the check answers when `/proc/net/tcp` holds the router's two rows and `callerRows`. */
const answerFor = Effect.fnUntraced(function* answerFor(callerRows: readonly string[], asked: Caller = connection) {
	const text = Array.join([heading, rows.listening, rows.routerEnd, ...callerRows, ""], "\n");

	const table = FileSystem.layerNoop({
		exists: () => Effect.succeed(true),
		readFileString: () => Effect.succeed(text),
	});

	const built = yield* Layer.build(Callers.layer.pipe(Layer.provide(table)));

	return yield* Context.get(built, Callers).isThisUser(asked);
});

/** What the check answers when `/proc/net/tcp` exists and cannot be read. */
const unreadable = Effect.gen(function* unreadable() {
	const table = FileSystem.layerNoop({ exists: () => Effect.succeed(true) });
	const built = yield* Layer.build(Callers.layer.pipe(Layer.provide(table)));

	return yield* Context.get(built, Callers).isThisUser(connection);
});

const exits = { failed: 1, listed: 0 } as const;

const lsofPid = 4321;

/** `lsof -F un` for the same connection, held by one uid: the caller's process, then the router's. */
const lsofPrinted = "p1\nu1000\nn127.0.0.1:33414->127.0.0.1:56717\np2\nu1000\nn127.0.0.1:56717->127.0.0.1:33414\n";

const lsofPrintedForAnotherUsersCaller =
	"p1\nu4242\nn127.0.0.1:33414->127.0.0.1:56717\np2\nu1000\nn127.0.0.1:56717->127.0.0.1:33414\n";

const exitsWith = (exitCode: number): Effect.Effect<ChildProcessSpawner.ExitCode> =>
	Effect.succeed(ChildProcessSpawner.ExitCode(exitCode));

/** What the check answers where there is no `/proc/net/tcp`, when `lsof` prints `printed` and exits as `exitCode` gives. */
const lsofAnswerFor = Effect.fnUntraced(function* lsofAnswerFor(
	printed: string,
	exitCode: () => Effect.Effect<ChildProcessSpawner.ExitCode>,
) {
	const noProcTable = FileSystem.layerNoop({ exists: () => Effect.succeed(false) });

	const lsof = ChildProcessSpawner.makeHandle({
		all: Stream.empty,
		exitCode: exitCode(),
		getInputFd: () => Sink.drain,
		getOutputFd: () => Stream.empty,
		isRunning: Effect.succeed(false),
		kill: () => Effect.void,
		pid: ChildProcessSpawner.ProcessId(lsofPid),
		stderr: Stream.empty,
		stdin: Sink.drain,
		stdout: Stream.make(new TextEncoder().encode(printed)),
		unref: Effect.die("the check never unrefs"),
	});

	const spawner = Layer.succeed(
		ChildProcessSpawner.ChildProcessSpawner,
		ChildProcessSpawner.make(() => Effect.succeed(lsof)),
	);

	const built = yield* Layer.build(Callers.layer.pipe(Layer.provide([noProcTable, spawner])));

	return yield* Context.get(built, Callers).isThisUser(connection);
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

it.layer(NodeServices.layer)("the caller check", (test) => {
	test.effect(
		"passes a caller whose end this user holds, and refuses another user's end, a missing end, a closed end, an end at another address, a table it cannot read, an lsof that failed and an lsof that gives the caller's process another uid",
		() => answers,
	);
	test.effect("refuses a caller once lsof has not exited within 2 seconds", () => slowLsof);
});
