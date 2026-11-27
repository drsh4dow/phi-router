import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ConfigProvider, Context, Effect, Layer, Path, String as Str, Stream } from "effect";
import { LeaseRequests } from "#router/client/router-port/index.ts";

const listening = "phi-router listens on ";

const leased = Effect.fnUntraced(function* leased(url: string, folder: string) {
	const built = yield* Layer.build(LeaseRequests.layer);
	const requests = Context.get(built, LeaseRequests);
	const lease = { folder, pid: process.pid, session: "tools" };
	const answered = yield* requests.post(Number(new URL(url).port), lease);

	if (answered !== "accepted") {
		return yield* Effect.die(`the router at ${url} answered the test's lease with ${answered}`);
	}

	return answered;
}, Effect.scoped);

const routerProcess = Effect.fnUntraced(function* routerProcess(
	command: readonly [string, ...string[]],
	env: Readonly<Record<string, string>>,
	checkout?: string,
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const path = yield* Path.Path;
	const cwd = checkout ?? path.resolve(import.meta.dirname, "../..");
	const [runtime, ...script] = command;

	const handle = yield* spawner.spawn(
		ChildProcess.make(runtime, [...script, "serve", "--port", "0"], { cwd, env, extendEnv: true }),
	);

	const line = yield* handle.stdout.pipe(
		Stream.decodeText,
		Stream.splitLines,
		Stream.filter(Str.startsWith(listening)),
		Stream.runHead,
		Effect.flatMap(Effect.fromOption),
	);

	const url = Str.slice(listening.length)(line);

	const routerConfig = ConfigProvider.orElse(ConfigProvider.fromEnv({ env }), ConfigProvider.fromEnv());

	yield* Effect.provideService(leased(url, cwd), ConfigProvider.ConfigProvider, routerConfig);

	return { kill: handle.kill({ killSignal: "SIGKILL" }), url };
});

export { routerProcess };
