import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Effect } from "effect";

const standardInput = Effect.gen(function* standardInput() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

	return yield* spawner.string(ChildProcess.make("cat", [], { stdin: "inherit" }));
});

export { standardInput };
