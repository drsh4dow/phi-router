import { Array, Effect, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { bundles } from "./bundles.ts";

const succeeded = 0;

const build = Effect.gen(function* build() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const path = yield* Path.Path;
	const cwd = path.resolve(import.meta.dirname, "../..");

	for (const { entry, out } of bundles) {
		const args = [
			"build",
			entry,
			"--minify",
			"--target",
			"node",
			"--define",
			"__filename=undefined",
			"--external",
			"@earendil-works/*",
			"--outfile",
			out,
		];

		yield* spawner.exitCode(ChildProcess.make("bun", args, { cwd, stderr: "inherit", stdout: "inherit" })).pipe(
			Effect.filterOrFail(
				(exitCode) => exitCode === succeeded,
				(exitCode) => `bun ${Array.join(args, " ")} exited ${String(exitCode)}`,
			),
		);
	}
});

NodeRuntime.runMain(Effect.provide(build, NodeServices.layer));
