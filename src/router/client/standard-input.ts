import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Effect } from "effect";

/**
 * Everything this process's stdin holds, read to its end, such as the JSON a harness writes to a session-start hook.
 * `cat` reads it from the inherited stdin, since `Stdio` is not among the Effect modules the repository allows, and
 * opening `/dev/stdin` fails with `ENXIO` when stdin is a socket, as a harness's pipe to its hook is (measured).
 */
const standardInput = Effect.gen(function* standardInput() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

	return yield* spawner.string(ChildProcess.make("cat", [], { stdin: "inherit" }));
});

export { standardInput };
