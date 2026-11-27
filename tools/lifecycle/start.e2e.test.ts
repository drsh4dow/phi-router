import { Array, Clock, Effect, FileSystem, Layer, Record, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { PlatformError, Scope } from "effect";
import { answers, bundled, instance, killedHard, leasedPids, refusedWithin, world } from "./launched.ts";
import { assert, it } from "@effect/vitest";
import { bodyOf, claudeRequest } from "#tools/route/mocked-router.ts";
import { NodeServices } from "@effect/platform-node";
import { TestClock } from "effect/testing";
import { stopped } from "#tools/route/stopped.ts";

const patient = { timeout: 60_000 };
const leaseIntervalAndAHalf = "7 seconds";
const tenSeconds = 10_000;
const fiveSeconds = 5000;
const done = { exitCode: 0, printed: "" };
const none = 0;
const oneRouter = 1;

const claudeAt = Effect.fnUntraced(function* claudeAt(port: number) {
	const client = yield* HttpClient.HttpClient;
	const body = yield* bodyOf([{ role: "user", text: "list the build steps" }]);

	const request = HttpClientRequest.prependUrl(`http://127.0.0.1:${String(port)}`)(
		claudeRequest({ body, session: "s1" }),
	);

	return yield* client.execute(request).pipe(
		Effect.map(({ status }) => String(status)),
		Effect.catchReason("HttpClientError", "TransportError", () => Effect.succeed("TransportError")),
	);
});

const twoInstances = Effect.fnUntraced(function* twoInstances() {
	const here = yield* bundled().pipe(Effect.flatMap(world));
	const first = yield* instance();
	const second = yield* instance();

	return { first, here, second };
});

const startedTwice = Effect.fnUntraced(function* startedTwice() {
	const { first, here, second } = yield* twoInstances();
	const started = yield* here.start(first.pid);
	const router = yield* here.routers;
	const joined = yield* here.start(second.pid);
	const routers = yield* here.routers;
	const leases = yield* leasedPids(here.state);

	const afterCheck = yield* Effect.sleep(leaseIntervalAndAHalf).pipe(
		Effect.andThen(answers(here.port)),
		TestClock.withLive,
	);

	return { afterCheck, first, here, joined, leases, router, routers, second, started };
});

const afterTheLastEnd = Effect.fnUntraced(function* afterTheLastEnd(port: number, home: string) {
	const fs = yield* FileSystem.FileSystem;
	const gone = yield* TestClock.withLive(refusedWithin(port, tenSeconds));
	const refused = yield* TestClock.withLive(claudeAt(port));
	const installed = yield* fs.readDirectory(home, { recursive: true });

	return { gone, installed, refused };
});

const lifecycle = Effect.fnUntraced(function* lifecycle() {
	const up = yield* startedTwice();

	yield* up.first.end;
	yield* up.second.end;

	const after = yield* afterTheLastEnd(up.here.port, up.here.home);
	const left = yield* up.here.routers;

	const received = yield* Effect.all(
		[up.here.mocks.open.received, up.here.mocks.baa.received, up.here.mocks.judge.received],
		{ concurrency: "unbounded" },
	);

	assert.deepStrictEqual(
		{
			afterCheck: up.afterCheck,
			joined: up.joined,
			leases: up.leases,
			left,
			received: pipe(
				received,
				Array.map((asked) => asked.length),
			),
			refused: after.refused,
			routerCount: up.router.length,
			routers: up.routers,
			started: up.started,
		},
		{
			afterCheck: true,
			joined: done,
			leases: [up.first.pid, up.second.pid],
			left: [],
			received: [none, none, none],
			refused: "TransportError",
			routerCount: oneRouter,
			routers: up.router,
			started: done,
		},
	);
	assert.isBelow(after.gone, tenSeconds);
	assert.deepStrictEqual(after.installed, [], "nothing was installed under HOME, no systemd or launchd unit");
}, Effect.scoped);

const crashed = Effect.fnUntraced(function* crashed(port: number, killed: number) {
	yield* killedHard(killed);
	yield* TestClock.withLive(refusedWithin(port, tenSeconds));

	const whileDown = yield* TestClock.withLive(claudeAt(port));

	return { killed, whileDown };
});

const adopted = Effect.fnUntraced(function* adopted() {
	const { first, here, second } = yield* twoInstances();

	yield* here.start(first.pid);

	const { killed, whileDown } = yield* here.routers.pipe(
		Effect.map(Array.head),
		Effect.flatMap(Effect.fromOption),
		Effect.flatMap((router) => crashed(here.port, router)),
	);

	const restarted = yield* here.start(second.pid);
	const leases = yield* leasedPids(here.state);

	yield* second.end;

	const stillUp = yield* Effect.sleep(leaseIntervalAndAHalf).pipe(
		Effect.andThen(answers(here.port)),
		TestClock.withLive,
	);

	const routers = yield* here.routers;

	assert.deepStrictEqual(
		{ leases, restarted, routerCount: routers.length, stillUp, whileDown },
		{
			leases: [first.pid, second.pid],
			restarted: done,
			routerCount: oneRouter,
			stillUp: true,
			whileDown: "TransportError",
		},
	);
	assert.notInclude(routers, killed);
}, Effect.scoped);

const ended = Effect.fnUntraced(function* ended() {
	const here = yield* bundled().pipe(Effect.flatMap(world));
	const gone = yield* instance();

	yield* gone.end;
	yield* TestClock.withLive(Effect.sleep("200 millis"));

	const refused = yield* here.start(gone.pid);

	assert.notStrictEqual(refused.exitCode, none);
	assert.include(refused.printed, "the process is not running");
}, Effect.scoped);

const endsASecondAfterTheFirstConnection = `
Bun.listen({
	hostname: "127.0.0.1",
	port: Number(process.env.PORT),
	socket: {
		data: () => {},
		open: (socket) => {
			setTimeout(() => process.exit(), 1000);
			socket.end();
		},
	},
});
console.log("held");
`;

const closingRouter = Effect.fnUntraced(function* closingRouter(port: number) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const env = { PORT: String(port) };
	const command = ChildProcess.make("bun", ["-e", endsASecondAfterTheFirstConnection], { env, extendEnv: true });
	const handle = yield* spawner.spawn(command);

	yield* Stream.runHead(Stream.decodeText(handle.stdout));
});

const waited = Effect.fnUntraced(function* waited() {
	const here = yield* bundled().pipe(Effect.flatMap(world));
	const holder = yield* instance();

	yield* closingRouter(here.port);

	const started = yield* here.start(holder.pid);
	const routers = yield* here.routers;

	assert.deepStrictEqual({ routers: routers.length, started }, { routers: oneRouter, started: done });
}, Effect.scoped);

const configHolding = Effect.fnUntraced(function* configHolding(files: Readonly<Record<string, string>>) {
	const fs = yield* FileSystem.FileSystem;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-config-" });

	yield* fs.makeDirectory(`${folder}/phi-router`);
	yield* Effect.forEach(
		Record.toEntries(files),
		([name, text]) => fs.writeFileString(`${folder}/phi-router/${name}`, text),
		{ concurrency: 1 },
	);

	return { XDG_CONFIG_HOME: folder };
});

interface Unstartable {
	readonly what: string;
	readonly env: () => Effect.Effect<
		Readonly<Record<string, string>>,
		PlatformError.PlatformError,
		FileSystem.FileSystem | Scope.Scope
	>;
	readonly line: string;
	readonly within: number;
}

const unstartable: readonly Unstartable[] = [
	{ env: () => configHolding({}), line: stopped.noBaaKey("pi"), what: "no config.json", within: fiveSeconds },
	{
		env: () => Effect.succeed({ PHI_TEST_BAA_KEY: "" }),
		line: stopped.noBaaKey("pi"),
		what: "a BAA key that cannot be read",
		within: fiveSeconds,
	},
	{
		env: () => configHolding({ "config.json": "{" }),
		line: stopped.notStarted("pi"),
		what: "a config.json the router cannot read",
		within: fiveSeconds,
	},
];

const stoppedBy = Effect.fnUntraced(function* stoppedBy({ env, line, within }: Unstartable) {
	const entry = yield* bundled();
	const more = yield* env();
	const here = yield* world(entry, more);
	const holder = yield* instance();
	const started = yield* TestClock.withLive(Clock.currentTimeMillis);
	const refused = yield* here.start(holder.pid);
	const finished = yield* TestClock.withLive(Clock.currentTimeMillis);
	const routers = yield* here.routers;

	assert.deepStrictEqual(
		{ exitCode: refused.exitCode, printed: refused.printed, routers },
		{ exitCode: 1, printed: `${line}\n`, routers: [] },
		"start prints the line alone, and no router runs",
	);
	assert.isBelow(finished - started, within);
}, Effect.scoped);

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("phi-router start", (test) => {
	test.effect(
		"the first start brings one router up, a second joins it, and the router is gone within 10 s of the last end",
		() => lifecycle(),
		patient,
	);

	test.effect(
		"a router launched after a crash adopts the stored leases and stays up while an adopted instance lives",
		() => adopted(),
		patient,
	);

	test.effect("start for a pid with no process fails and leaves no lease", () => ended(), patient);

	test.effect(
		"start waits for a closing router to free the port, then brings its own router up there",
		() => waited(),
		patient,
	);

	test.effect.each(unstartable)("start with $what prints the line pi shows for it", stoppedBy, patient);
});
