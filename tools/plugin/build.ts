import { Array, Effect, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { NodeRuntime, NodeServices } from "@effect/platform-node";

/** `process.argv` holds the runtime and the script before the arguments. */
const runtimeAndScript = 2;

const succeeded = 0;

/** Runs one command from the repository root with its output on this process's, and fails unless it exits 0. */
const step = Effect.fnUntraced(function* step(command: string, args: readonly string[]) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const path = yield* Path.Path;
	const cwd = path.resolve(import.meta.dirname, "../..");
	const options = { cwd, stderr: "inherit", stdout: "inherit" } as const;
	const exitCode = yield* spawner.exitCode(ChildProcess.make(command, args, options));

	if (exitCode !== succeeded) {
		return yield* Effect.fail(`${command} ${Array.join(args, " ")} exited ${String(exitCode)}`);
	}

	return exitCode;
});

/** Each one-file bundle: its entry, and its path under the plugins folder. */
const bundles = [
	{ entry: "src/router/main.ts", out: "claude/phi-router.mjs" },
	{ entry: "src/pi/index.ts", out: "pi/extension.mjs" },
] as const;

/**
 * Bundles the router's entry into the plugin's one file, `plugins/claude/phi-router.mjs`, and pi's entry into the pi
 * package's, `plugins/pi/extension.mjs`, or both under the folder in the first argument. `__filename` is defined away,
 * since `@effect/platform-node` would embed this checkout's absolute path through it. pi's own packages stay imports,
 * which pi's loader resolves to the pi that loads the extension. oxfmt then formats each bundle with the repository's
 * config, so `oxfmt --check` passes it as committed.
 */
const build = Effect.gen(function* build() {
	const path = yield* Path.Path;
	const [given = "plugins"] = Array.drop(process.argv, runtimeAndScript);
	const config = path.resolve(import.meta.dirname, "../../.oxfmtrc.json");

	for (const { entry, out } of bundles) {
		const file = path.resolve(given, out);

		yield* step("bun", [
			"build",
			entry,
			"--target",
			"node",
			"--define",
			"__filename=undefined",
			"--external",
			"@earendil-works/*",
			"--outfile",
			file,
		]);
		yield* step("node_modules/.bin/oxfmt", ["--config", config, file]);
	}
});

NodeRuntime.runMain(Effect.provide(build, NodeServices.layer));
