import { Array, Effect, Layer, Option, String as Str, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Processes } from "#router/client/processes.ts";
import type { Running } from "#router/client/processes.ts";
import { TestClock } from "effect/testing";

/** A shell that forks `sleep 0.1`, prints its pid and becomes `sleep 30` without reaping it: a zombie within 0.1 s. */
const zombieMaker = ChildProcess.make("sh", ["-c", "sleep 0.1 & echo $!; exec sleep 30"]);

/** The pid of a process that ran `true` and has ended. */
const endedPid = Effect.fnUntraced(function* endedPid() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const done = yield* spawner.spawn(ChildProcess.make("true"));

	yield* done.exitCode;

	return Number(done.pid);
});

/** The pid of a running shell and of the zombie child it holds, once that child has ended. */
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

const pidsOf = Array.map(({ pid }: Running) => pid);

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

/** A spawner whose every spawn throws, as Node's does for E2BIG or ENOMEM: a defect, not a failure. */
const throwing = Layer.succeed(
	ChildProcessSpawner.ChildProcessSpawner,
	ChildProcessSpawner.make(() => Effect.die(new Error("spawn E2BIG"))),
);

const init = 1;

it.layer(Layer.provide(Processes.layer, throwing))("a ps that could not be spawned", (test) => {
	test.effect("reads nothing, so no lease is dropped", () =>
		Effect.gen(function* unspawned() {
			const processes = yield* Processes;
			const read = yield* processes.running([init]);

			assert.isTrue(Option.isNone(read));
		}),
	);
});
