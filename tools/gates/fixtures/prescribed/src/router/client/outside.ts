import { Effect, FileSystem } from "effect";
import { ChildProcess } from "effect/process";
import { HttpClient } from "effect/http";

/** Reaches disk, HTTP and a process, which only a client/ file may. */
const outside = Effect.gen(function* outside() {
	const fs = yield* FileSystem.FileSystem;
	const client = yield* HttpClient.HttpClient;

	return { client, command: ChildProcess.make("true"), fs };
});

export { outside };
