import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Context, Effect, Layer, Path, String as Str, Stream } from "effect";
import { LeaseRequests } from "#router/client/lease-request.ts";

const listening = "phi-router listens on ";

/** Leaves a lease for this test process with the router at `url`, so the router runs as long as this process. */
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

/**
 * The router as its own process: `command` plus `serve --port 0`, run from the repository with `env` beside the
 * caller's own. Once it prints that it listens, it holds a lease for this test process, so it runs until the scope ends
 * it or this process ends. Returns its URL and a SIGKILL.
 */
const routerProcess = Effect.fnUntraced(function* routerProcess(
	command: readonly [string, ...string[]],
	env: Readonly<Record<string, string>>,
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const path = yield* Path.Path;
	const cwd = path.resolve(import.meta.dirname, "../..");
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

	yield* leased(url, cwd);

	return { kill: handle.kill({ killSignal: "SIGKILL" }), url };
});

export { routerProcess };
