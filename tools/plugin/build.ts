import { Array, Effect, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { bundles } from "./bundles.ts";

const succeeded = 0;

/**
 * Bundles and minifies the router's entry into the plugin's one file, `plugins/claude/phi-router.mjs`, and pi's entry
 * into the pi package's, `plugins/pi/extension.mjs`. `__filename` is defined away, since `@effect/platform-node` would
 * embed this checkout's absolute path through it. pi's own packages stay imports, which pi's loader resolves to the pi
 * that loads the extension.
 */
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
