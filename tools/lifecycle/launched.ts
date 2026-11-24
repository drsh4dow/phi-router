import {
	Array,
	Clock,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
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

/** Runs a command to its end with `env` beside the caller's own, and returns its exit code and what it printed on stdout and stderr. */
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

const bundled = Effect.fnUntraced(function* bundled() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-bundle-" });
	const entry = path.join(folder, "phi-router.js");
	const source = path.resolve(import.meta.dirname, "../../src/router/main.ts");

	yield* ran(["bun", "build", source, "--target", "node", "--outfile", entry], {});

	return entry;
});

/** How far below the port it holds `freePort` hands one out, which puts it under 32768, where Linux's range for port 0 starts. */
const belowHeld = 30_000;

/** The Fetch standard's bad ports (https://fetch.spec.whatwg.org/#port-blocking), which the router's `fetch` refuses. */
const badPorts: ReadonlySet<string> = new Set(
	Str.split(
		"0 1 7 9 11 13 15 17 19 20 21 22 23 25 37 42 43 53 69 77 79 87 95 101 102 103 104 109 110 111 113 115 117 119 123 135 137 139 143 161 179 389 427 465 512 513 514 515 526 530 531 532 540 548 554 556 563 587 601 636 989 990 993 995 1719 1720 1723 2049 3659 4045 4190 5060 5061 6000 6566 6665 6666 6667 6668 6669 6679 6697 10080",
		" ",
	),
);

/**
 * The port `freePort` hands out while it holds `held`: the one 30000 below, or none when Fetch refuses that one.
 *
 * @param {number} held The port `freePort` holds.
 * @returns {Option.Option<number>} The port to hand out, if Fetch takes it.
 */
const portBelow = (held: number): Option.Option<number> =>
	Option.filter(Option.some(held - belowHeld), (port) => !badPorts.has(String(port)));

const freePort = Effect.gen(function* freePort() {
	const built = yield* Layer.build(NodeHttpServer.layerTest);
	const { address } = Context.get(built, HttpServer.HttpServer);
	const held = yield* pipe(HttpServer.formatAddress(address), Str.split(":"), Array.last, Effect.fromOption);

	return portBelow(Number(held));
}).pipe(Effect.repeat({ until: Option.isSome }), Effect.flatMap(Effect.fromOption));

/** A stand-in harness instance: a `sleep` the scope kills. Returns its pid and a SIGKILL. */
const instance = Effect.fnUntraced(function* instance() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const handle = yield* spawner.spawn(ChildProcess.make("sleep", ["300"]));

	return { end: handle.kill({ killSignal: "SIGKILL" }), pid: Number(handle.pid) };
});

/**
 * The command line of a router that serves `port` from the bundle `entry`. Each test's bundle has its own temp folder,
 * so it names no router of another test, even one on the same port in another network namespace.
 *
 * @param {string} entry The bundle the router runs.
 * @param {number} port The port it serves.
 * @returns {string} A pattern for `pgrep -f` and `pkill -f`.
 */
const serving = (entry: string, port: number): string => `${entry} serve --port ${String(port)}$`;

const routersOn = Effect.fnUntraced(function* routersOn(entry: string, port: number) {
	const { printed } = yield* ran(["pgrep", "-f", serving(entry, port)], {});

	return pipe(Str.split(Str.trim(printed), "\n"), Array.filter(Str.isNonEmpty), Array.map(Number));
});

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

/** Polls every 100 ms until the port refuses connections, and returns how long that took. Gives up after `limit`. */
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

/**
 * One world for a lifecycle test: the three mocks, a fresh config and state folder, a fresh HOME and a free port.
 * `start` runs `phi-router start` from the bundle `entry` for a pid with that environment and `more`, and `routers`
 * lists the routers it launched that still run. The scope kills them.
 */
const world = Effect.fnUntraced(function* world(entry: string, more: Readonly<Record<string, string>> = {}) {
	const fs = yield* FileSystem.FileSystem;
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-home-" });
	const { env: mockEnv, mocks, state } = yield* mocked({ holdsPhi: () => false });
	const env = Struct.assign(Struct.assign(mockEnv, { HOME: home }), more);
	const port = yield* freePort;

	yield* Effect.addFinalizer(() => ran(["pkill", "-9", "-f", serving(entry, port)], {}).pipe(Effect.orDie));

	const start = (pid: number): ReturnType<typeof ran> =>
		ran(
			["node", entry, "start", "--pid", String(pid), "--session", "s1", "--folder", "/work", "--port", String(port)],
			env,
		);

	return { home, mocks, port, routers: routersOn(entry, port), start, state };
});

export {
	answers,
	badPorts,
	bundled,
	freePort,
	instance,
	leasedPids,
	leasesIn,
	portBelow,
	ran,
	refusedWithin,
	routersOn,
	world,
};
