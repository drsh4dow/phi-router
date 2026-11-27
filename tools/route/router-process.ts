import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Context, Effect, FileSystem, Layer, Option, Path, Record, Schema, String as Str, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { LeaseRequestJson, LeaseRequests, callerHeader, leasePath } from "#router/client/router-port/index.ts";
import type { HttpClientError } from "effect/http";
import type { PlatformError } from "effect";

const listening = "phi-router listens on ";

const accepted = 200;

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

const leasedWithToken = Effect.fnUntraced(function* leasedWithToken(url: string, folder: string, state: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const token = yield* fs.readFileString(path.join(state, "phi-router", "caller-token"));
	const body = yield* Schema.encodeEffect(LeaseRequestJson)({ folder, pid: process.pid, session: "tools" });

	const sent = HttpClientRequest.post(`${url}${leasePath}`).pipe(
		HttpClientRequest.setHeaders({ [callerHeader]: Str.trim(token) }),
		HttpClientRequest.bodyText(body, "application/json"),
	);

	const built = yield* Layer.build(FetchHttpClient.layer);
	const client = Context.get(built, HttpClient.HttpClient);
	const answer = yield* client.execute(sent);

	if (answer.status !== accepted) {
		return yield* Effect.die(`the router at ${url} answered the test's lease with ${String(answer.status)}`);
	}

	return "accepted";
}, Effect.scoped);

const leasedOn = (
	url: string,
	folder: string,
	env: Readonly<Record<string, string>>,
): Effect.Effect<
	string,
	HttpClientError.HttpClientError | PlatformError.PlatformError | Schema.SchemaError,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> => {
	const state = Record.get(env, "XDG_STATE_HOME");

	if (process.platform === "win32" && Option.isSome(state)) {
		return leasedWithToken(url, folder, state.value);
	}

	return leased(url, folder);
};

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

	yield* leasedOn(url, cwd, env);

	return { kill: handle.kill({ killSignal: "SIGKILL" }), url };
});

export { routerProcess };
