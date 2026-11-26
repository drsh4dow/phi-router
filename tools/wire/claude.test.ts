import { Array, ConfigProvider, Effect, FileSystem, Path, String as Str, pipe } from "effect";
import { assert, it, vi } from "@effect/vitest";
import { claudeTurn, place } from "./claude-turn.ts";
import { NodeServices } from "@effect/platform-node";
import { fakes } from "#tools/route/mocked-router.ts";
import { succeeded } from "./checks.ts";

const callerOnly = "PHI_WIRE_CALLER_ONLY";

const printsArgsAndEnv = "#!/bin/sh\nprintf '%s\\n' \"$@\"\nenv\n";

const executable = 0o755;

const fresh = Effect.gen(function* fresh() {
	const fs = yield* FileSystem.FileSystem;

	const [first, second] = yield* Effect.all([place, place], { concurrency: 1 });
	const made = [first.config, first.home, first.work, second.config, second.home, second.work];
	const entries = yield* Effect.forEach(made, (folder) => fs.readDirectory(folder), { concurrency: 1 });

	return { entries, made, plugins: [first.plugin, second.plugin] };
});

const placesThenGone = Effect.gen(function* placesThenGone() {
	const fs = yield* FileSystem.FileSystem;
	const { entries, made, plugins } = yield* Effect.scoped(fresh);
	const all = [...made, ...plugins];
	const left = yield* Effect.forEach(all, (folder) => fs.exists(folder), { concurrency: 1 });

	assert.strictEqual(Array.dedupe(all).length, all.length, "no folder is shared");
	assert.isTrue(pipe(entries, Array.every(Array.isReadonlyArrayEmpty)), "every folder starts empty");
	assert.notInclude(left, true, "every folder is gone with its scope");
});

const withCallerVariable = Effect.acquireRelease(
	Effect.sync(() => {
		vi.stubEnv(callerOnly, "leaked");
	}),
	() =>
		Effect.sync(() => {
			vi.unstubAllEnvs();
		}),
);

const turnWithFakeClaude = Effect.gen(function* turnWithFakeClaude() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const bin = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-bin-" });
	const where = yield* place;
	const searchPath = ConfigProvider.fromEnv({ env: { PATH: `${bin}:/usr/bin:/bin` } });

	yield* fs.writeFileString(path.join(bin, "claude"), printsArgsAndEnv, { mode: executable });
	yield* withCallerVariable;

	const turned = yield* claudeTurn({
		folders: { XDG_CONFIG_HOME: where.config, XDG_STATE_HOME: where.work },
		place: where,
		prompt: "Reply with ok.",
		router: "http://127.0.0.1:9",
		session: [],
	}).pipe(Effect.provideService(ConfigProvider.ConfigProvider, searchPath));

	return { turned, where };
});

const keepsTheCallerOut = Effect.gen(function* keepsTheCallerOut() {
	const { turned, where } = yield* turnWithFakeClaude;
	const lines = Str.split("\n")(turned.printed);
	const has = (line: string): boolean => pipe(lines, Array.contains(line));

	assert.strictEqual(turned.exitCode, succeeded, turned.printed);
	assert.isFalse(Str.includes(callerOnly)(turned.printed), "a variable of the caller reached claude");
	assert.isTrue(has(`HOME=${where.home}`), turned.printed);
	assert.isTrue(has(`CLAUDE_CONFIG_DIR=${where.config}`), turned.printed);
	assert.isTrue(has(`ANTHROPIC_AUTH_TOKEN=${fakes.harnessToken}`), turned.printed);
}).pipe(Effect.scoped);

it.layer(NodeServices.layer)("a wire run's claude", (test) => {
	test.effect(
		"gets a new empty home, config and working folder and plugin copy per place, gone with its scope",
		() => placesThenGone,
	);
	test.effect(
		"sees no variable of the caller's, and its home, config and login are the place's and the fake's",
		() => keepsTheCallerOut,
	);
});
