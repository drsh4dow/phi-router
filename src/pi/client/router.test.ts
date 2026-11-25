import { Array, Effect, Equal, Layer, Option, PlatformError, Record, Redacted, Ref, Sink, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { CommandFailed, SessionId } from "#shared/cli.ts";
import { assert, it } from "@effect/vitest";
import { Router } from "#pi/client/router.ts";

interface Reply {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr?: string;
}

const clean = 0;

const failed = 1;

const misused = 2;

const anyPid = 1;

const routerPort = 47_499;

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

const exitedLine =
	'{"accounts":{"clean":[{"name":"open","vendor":"anthropic"}],"sealed":[{"name":"baa","vendor":"anthropic"}]},"cleared":2,"last":{"account":"baa","model":"m","substitute":false},"sealed":1,"session":"exits"}';

const replies: readonly { readonly argv: readonly string[]; readonly reply: Reply }[] = [
	{ argv: leasing, reply: { exitCode: clean, stdout: "" } },
	{
		argv: ["phi-router", "status", "--session", "s1", "--port", String(routerPort)],
		reply: {
			exitCode: clean,
			stdout:
				'{"accounts":{"clean":[{"name":"open","vendor":"anthropic"}],"sealed":[{"name":"baa","vendor":"anthropic"}]},"cleared":2,"last":{"account":"baa","model":"m","substitute":false},"sealed":1,"session":"s1"}',
		},
	},
	{
		argv: ["phi-router", "status", "--session", "exits", "--port", String(routerPort)],
		reply: {
			exitCode: failed,
			stderr: "phi-router: the router refused the session",
			stdout: exitedLine,
		},
	},
	{
		argv: ["phi-router", "status", "--session", "garbled", "--port", String(routerPort)],
		reply: { exitCode: clean, stdout: "phi-router: no such session" },
	},
	{
		argv: ["phi-router", "status", "--session", "fresh", "--port", String(routerPort)],
		reply: {
			exitCode: clean,
			stdout: '{"accounts":{"clean":[],"sealed":[]},"cleared":0,"last":null,"sealed":0,"session":"fresh"}',
		},
	},
	{
		argv: ["phi-router", "models"],
		reply: { exitCode: clean, stdout: '{"anthropic":{"auto":"claude-auto","sealed":"claude-baa"}}' },
	},
];

const usage: Reply = { exitCode: misused, stdout: "" };

const handle = (reply: Reply): ChildProcessSpawner.ChildProcessHandle => {
	const encoder = new TextEncoder();

	return ChildProcessSpawner.makeHandle({
		all: Stream.empty,
		exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(reply.exitCode)),
		getInputFd: () => Sink.drain,
		getOutputFd: () => Stream.empty,
		isRunning: Effect.succeed(false),
		kill: () => Effect.void,
		pid: ChildProcessSpawner.ProcessId(anyPid),
		stderr: Stream.make(encoder.encode(reply.stderr ?? "")),
		stdin: Sink.drain,
		stdout: Stream.make(encoder.encode(reply.stdout)),
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
				sealed: 1,
				session: SessionId.make("s1"),
			});
		}),
	);

	test.effect("decodes the status line of a session before its first request", () =>
		Effect.gen(function* fresh() {
			const router = yield* Router;
			const status = yield* router.status(SessionId.make("fresh"), routerPort);

			assert.isNull(status.last);
		}),
	);

	test.effect("fails with CommandFailed when the CLI exits non-zero, even after printing a status line", () =>
		Effect.gen(function* exited() {
			const router = yield* Router;
			const failure = yield* Effect.flip(router.status(SessionId.make("exits"), routerPort));

			assert.instanceOf(failure, CommandFailed);
			assert.deepStrictEqual(
				{ cause: failure.cause, command: failure.command },
				{
					cause: `${exitedLine}\nphi-router: the router refused the session`,
					command: "status",
				},
			);
		}),
	);

	test.effect("fails with CommandFailed when the CLI prints what the contract does not allow", () =>
		Effect.gen(function* garbled() {
			const router = yield* Router;
			const failure = yield* Effect.flip(router.status(SessionId.make("garbled"), routerPort));

			assert.instanceOf(failure, CommandFailed);
			assert.strictEqual(failure.command, "status");
		}),
	);

	test.effect("reads the models phi-router models prints, asking no router", () =>
		Effect.gen(function* models() {
			const router = yield* Router;
			const named = yield* router.models;

			assert.deepStrictEqual(named, { anthropic: { auto: "claude-auto", sealed: "claude-baa" } });
		}),
	);
});

const unspawned = Layer.succeed(
	ChildProcessSpawner.ChildProcessSpawner,
	ChildProcessSpawner.make(() => Effect.fail(PlatformError.badArgument({ method: "spawn", module: "ChildProcess" }))),
);

it.layer(Layer.provide(Router.layer("phi-router"), unspawned))("the pi router client without a CLI", (test) => {
	test.effect("fails with CommandFailed naming the command when the CLI does not start", () =>
		Effect.gen(function* notStarted() {
			const router = yield* Router;
			const failure = yield* Effect.flip(router.status(SessionId.make("s1"), routerPort));

			assert.instanceOf(failure, CommandFailed);
			assert.strictEqual(failure.command, "status");
		}),
	);
});

const readyLine =
	'{"found":["phi-router found"],"keys":[{"prompt":"OpenAI key (PHI check):","vendor":"openai"}],"kind":"ready"}';

const heldKey = "sk-proj-held-in-the-environment";

const spawned: ChildProcess.StandardCommand[] = [];

const applyReply: Reply = { exitCode: clean, stdout: "✓ OpenAI key works\n\n  PHI check       OpenAI\n" };

const setupCli = Layer.succeed(
	ChildProcessSpawner.ChildProcessSpawner,
	ChildProcessSpawner.make((command) => {
		if (!ChildProcess.isStandardCommand(command)) {
			return Effect.succeed(handle(usage));
		}

		spawned.push(command);

		if (Array.contains(command.args, "--apply")) {
			return Effect.succeed(handle(applyReply));
		}

		return Effect.succeed(handle({ exitCode: clean, stdout: readyLine }));
	}),
);

const lastSpawned = (): Option.Option<ChildProcess.StandardCommand> => Array.last(spawned);

it.layer(Layer.provide(Router.layer("phi-router"), setupCli))("the pi router client's setup", (test) => {
	test.effect("asks phi-router setup pi --json for the step that follows the picks, and decodes it", () =>
		Effect.gen(function* stepped() {
			const router = yield* Router;
			const step = yield* router.setupStep({ baa: "key" });

			assert.deepStrictEqual(step, {
				found: ["phi-router found"],
				keys: [{ prompt: "OpenAI key (PHI check):", vendor: "openai" }],
				kind: "ready",
			});
			assert.deepStrictEqual(
				Option.map(lastSpawned(), ({ args, command }) => [command, ...args]),
				Option.some(["phi-router", "setup", "pi", "--json", "--answers", '{"baa":"key"}']),
			);
		}),
	);

	test.effect(
		"hands each typed key to phi-router setup pi --apply in its environment alone, and shows each line it prints",
		() =>
			Effect.gen(function* applied() {
				const router = yield* Router;
				const shown = yield* Ref.make<readonly string[]>([]);

				yield* router.setUp({
					answers: { baa: "key" },
					keys: [{ key: Redacted.make(heldKey), vendor: "openai" }],
					shown: (line) => Ref.update(shown, Array.append(line)),
				});

				const command = yield* Effect.fromOption(lastSpawned());
				const lines = yield* Ref.get(shown);

				const given = pipe(
					Option.fromNullishOr(command.options.env),
					Option.flatMap(Record.get("PHI_ROUTER_OPENAI_KEY")),
					Option.filter(Redacted.isRedacted),
					Option.map(Redacted.value),
				);

				assert.deepStrictEqual(
					[command.command, ...command.args],
					["phi-router", "setup", "pi", "--apply", "--answers", '{"baa":"key"}'],
				);
				assert.deepStrictEqual(given, Option.some(heldKey));
				assert.isTrue(command.options.extendEnv);
				assert.deepStrictEqual(lines, ["✓ OpenAI key works", "", "  PHI check       OpenAI"]);
			}),
	);
});
