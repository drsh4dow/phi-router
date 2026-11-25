import type { Config, PlatformError } from "effect";
import { ConfigProvider, Effect, Fiber, FileSystem, Layer, Option, Path, Redacted, Sink, Stream, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { storedKey } from "./index.ts";

const anyPid = 1;

const succeeded = 0;

const refused = 1;

const printedKey = "sk-ant-api03-phi-test-printed-key";

const exitCodes = {
	exits: Effect.succeed(ChildProcessSpawner.ExitCode(succeeded)),
	exitsNonZero: Effect.succeed(ChildProcessSpawner.ExitCode(refused)),
	hangs: Effect.never,
};

const piPrinting = (ending: keyof typeof exitCodes): ChildProcessSpawner.ChildProcessHandle =>
	ChildProcessSpawner.makeHandle({
		all: Stream.empty,
		exitCode: exitCodes[ending],
		getInputFd: () => Sink.drain,
		getOutputFd: () => Stream.empty,
		isRunning: Effect.succeed(true),
		kill: () => Effect.void,
		pid: ChildProcessSpawner.ProcessId(anyPid),
		stderr: Stream.empty,
		stdin: Sink.drain,
		stdout: Stream.encodeText(Stream.make(`${printedKey}\n`)),
		unref: Effect.die("pi's key print is never unrefed"),
	});

type Ending = keyof typeof exitCodes;

const agentOnDisk = Layer.mergeAll(
	FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
	Path.layer,
	ConfigProvider.layer(
		ConfigProvider.fromEnv({
			env: { HOME: "/home/dev", PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/home/dev/.pi/agent" },
		}),
	),
);

const keyOf = (
	ending: Ending,
): Effect.Effect<string, Config.ConfigError | PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* keyAfterPatience() {
		const stored = yield* Effect.forkChild(storedKey("anthropic"));

		yield* TestClock.adjust("30 seconds");

		const key = yield* Fiber.join(stored);

		return pipe(
			key,
			Option.map(Redacted.value),
			Option.getOrElse(() => "none"),
		);
	}).pipe(
		Effect.provideService(
			ChildProcessSpawner.ChildProcessSpawner,
			ChildProcessSpawner.make(() => Effect.succeed(piPrinting(ending))),
		),
	);

it.layer(agentOnDisk)("the Anthropic key pi stored", (test) => {
	test.effect("is the one pi prints when it exits 0", () =>
		Effect.map(keyOf("exits"), (key) => {
			assert.strictEqual(key, printedKey);
		}),
	);

	test.effect("is none when pi prints a key but exits non-zero", () =>
		Effect.map(keyOf("exitsNonZero"), (key) => {
			assert.strictEqual(key, "none");
		}),
	);

	test.effect("is none when pi has not exited after 30 seconds", () =>
		Effect.map(keyOf("hangs"), (key) => {
			assert.strictEqual(key, "none");
		}),
	);
});
