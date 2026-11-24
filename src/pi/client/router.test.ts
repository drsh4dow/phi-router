import { Array, Effect, Equal, Layer, Option, Sink, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { CommandFailed, SessionId } from "#shared/cli.ts";
import { assert, it } from "@effect/vitest";
import { Router } from "#pi/client/router.ts";

interface Reply {
	readonly exitCode: number;
	readonly stdout: string;
}

const clean = 0;

const failed = 1;

const misused = 2;

const anyPid = 1;

const routerPort = 47_499;

/** `start` through `sh`, so the lease names the pid of the process that runs the client, pi's own. */
const leasing = [
	"sh",
	"-c",
	'exec "$0" "$@" --pid "$PPID"',
	"phi-router",
	"start",
	"--session",
	"s1",
	"--folder",
	"/work",
	"--port",
	String(routerPort),
];

const replies: readonly { readonly argv: readonly string[]; readonly reply: Reply }[] = [
	{ argv: leasing, reply: { exitCode: clean, stdout: "" } },
	{
		argv: ["phi-router", "status", "--session", "s1", "--port", String(routerPort)],
		reply: {
			exitCode: clean,
			stdout:
				'{"accounts":{"clean":[{"name":"open","vendor":"anthropic"}],"sealed":[{"name":"baa","vendor":"anthropic"}]},"cleared":2,"last":{"account":"baa","model":"m","substitute":false},"pinned":true,"sealed":1,"session":"s1"}',
		},
	},
	{
		argv: ["phi-router", "status", "--session", "exits", "--port", String(routerPort)],
		reply: {
			exitCode: failed,
			stdout:
				'{"accounts":{"clean":[{"name":"open","vendor":"anthropic"}],"sealed":[{"name":"baa","vendor":"anthropic"}]},"cleared":2,"last":{"account":"baa","model":"m","substitute":false},"pinned":true,"sealed":1,"session":"exits"}',
		},
	},
	{
		argv: ["phi-router", "status", "--session", "garbled", "--port", String(routerPort)],
		reply: { exitCode: clean, stdout: "phi-router: no such session" },
	},
	{
		argv: ["phi-router", "pin", "--session", "s1", "--port", String(routerPort)],
		reply: { exitCode: clean, stdout: "" },
	},
	{
		argv: ["phi-router", "unpin", "--session", "s1", "--port", String(routerPort)],
		reply: { exitCode: clean, stdout: "" },
	},
	{
		argv: ["phi-router", "pin", "--session", "down", "--port", String(routerPort)],
		reply: { exitCode: failed, stdout: "" },
	},
];

const usage: Reply = { exitCode: misused, stdout: "" };

const handle = (reply: Reply): ChildProcessSpawner.ChildProcessHandle => {
	const stdout = new TextEncoder().encode(reply.stdout);

	return ChildProcessSpawner.makeHandle({
		all: Stream.empty,
		exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(reply.exitCode)),
		getInputFd: () => Sink.drain,
		getOutputFd: () => Stream.empty,
		isRunning: Effect.succeed(false),
		kill: () => Effect.void,
		pid: ChildProcessSpawner.ProcessId(anyPid),
		stderr: Stream.empty,
		stdin: Sink.drain,
		stdout: Stream.make(stdout),
		unref: Effect.die("the router client never unrefs"),
	});
};

const cli = Layer.succeed(
	ChildProcessSpawner.ChildProcessSpawner,
	ChildProcessSpawner.make((command) => {
		const known = pipe(
			replies,
			Array.findFirst(
				(row) =>
					ChildProcess.isStandardCommand(command) && Equal.equals(row.argv, [command.command, ...command.args]),
			),
		);

		const reply = Option.match(known, { onNone: () => usage, onSome: (row) => row.reply });

		return Effect.succeed(handle(reply));
	}),
);

it.layer(Layer.provide(Router.layer("phi-router"), cli))("the pi router client", (test) => {
	test.effect("leaves the lease for the session, its folder and the port, on the pid of the client's process", () =>
		Effect.gen(function* leased() {
			const router = yield* Router;

			yield* router.start("s1", "/work", routerPort);
		}),
	);

	test.effect("decodes the status line the router CLI prints for the session", () =>
		Effect.gen(function* decoded() {
			const router = yield* Router;
			const status = yield* router.status(SessionId.make("s1"), routerPort);

			assert.deepStrictEqual(status, {
				accounts: {
					clean: [{ name: "open", vendor: "anthropic" }],
					sealed: [{ name: "baa", vendor: "anthropic" }],
				},
				cleared: 2,
				last: { account: "baa", model: "m", substitute: false },
				pinned: true,
				sealed: 1,
				session: SessionId.make("s1"),
			});
		}),
	);

	test.effect("fails with CommandFailed when the CLI exits non-zero, even after printing a status line", () =>
		Effect.gen(function* exited() {
			const router = yield* Router;
			const failure = yield* Effect.flip(router.status(SessionId.make("exits"), routerPort));

			assert.instanceOf(failure, CommandFailed);
		}),
	);

	test.effect("fails with CommandFailed when the CLI prints what the contract does not allow", () =>
		Effect.gen(function* garbled() {
			const router = yield* Router;
			const failure = yield* Effect.flip(router.status(SessionId.make("garbled"), routerPort));

			assert.instanceOf(failure, CommandFailed);
		}),
	);
});

it.layer(Layer.provide(Router.layer("phi-router"), cli))("the pi router client's pin", (test) => {
	test.effect(
		"pins and unpins the session through the router on the port, and fails with CommandFailed when the CLI does",
		() =>
			Effect.gen(function* pinned() {
				const router = yield* Router;

				yield* router.pin(SessionId.make("s1"), routerPort);
				yield* router.unpin(SessionId.make("s1"), routerPort);

				const failure = yield* Effect.flip(router.pin(SessionId.make("down"), routerPort));

				assert.instanceOf(failure, CommandFailed);
			}),
	);
});
