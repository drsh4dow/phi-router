import { Array, ConfigProvider, Effect, Exit, FileSystem, Path, String as Str, pipe } from "effect";
import { assert, it, vi } from "@effect/vitest";
import { codexRun, gitRepo, place } from "./codex.ts";
import { NodeServices } from "@effect/platform-node";
import type { Scope } from "effect";
import { succeeded } from "./checks.ts";

const patient = { timeout: 30_000 };

const callerOnly = "PHI_WIRE_CALLER_ONLY";

const readsStdinThenPrintsEnv = "#!/bin/sh\ncat\nenv\n";

const signsWithAFailingProgram = "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n";

const executable = 0o755;

const inCaller = (name: string, value: string): Effect.Effect<void, never, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.sync(() => {
			vi.stubEnv(name, value);
		}),
		() =>
			Effect.sync(() => {
				vi.unstubAllEnvs();
			}),
	);

const fresh = Effect.gen(function* fresh() {
	const fs = yield* FileSystem.FileSystem;

	const [first, second] = yield* Effect.all([place, place], { concurrency: 1 });

	const made = [
		first.bundledCodexHome,
		first.home,
		first.routedCodexHome,
		first.work,
		second.bundledCodexHome,
		second.home,
		second.routedCodexHome,
		second.work,
	];

	const entries = yield* Effect.forEach(made, (folder) => fs.readDirectory(folder), { concurrency: 1 });

	return { entries, made };
});

const placesThenGone = Effect.gen(function* placesThenGone() {
	const fs = yield* FileSystem.FileSystem;
	const { entries, made } = yield* Effect.scoped(fresh);
	const left = yield* Effect.forEach(made, (folder) => fs.exists(folder), { concurrency: 1 });

	assert.strictEqual(Array.dedupe(made).length, made.length, "no folder is shared");
	assert.isTrue(pipe(entries, Array.every(Array.isReadonlyArrayEmpty)), "every folder starts empty");
	assert.notInclude(left, true, "every folder is gone with its scope");
});

const runWithFakeCodex = Effect.gen(function* runWithFakeCodex() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const bin = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-bin-" });
	const where = yield* place;
	const searchPath = ConfigProvider.fromEnv({ env: { PATH: `${bin}:/usr/bin:/bin` } });

	yield* fs.writeFileString(path.join(bin, "codex"), readsStdinThenPrintsEnv, { mode: executable });
	yield* inCaller(callerOnly, "leaked");

	const ran = yield* codexRun({
		args: ["exec", "Reply with ok."],
		codexHome: where.routedCodexHome,
		folders: {},
		place: where,
		router: "http://127.0.0.1:9",
	}).pipe(Effect.provideService(ConfigProvider.ConfigProvider, searchPath));

	return { ran, where };
});

const keepsTheCallerOut = Effect.gen(function* keepsTheCallerOut() {
	const { ran, where } = yield* runWithFakeCodex;
	const lines = Str.split("\n")(ran.stdout);
	const has = (line: string): boolean => pipe(lines, Array.contains(line));

	assert.strictEqual(ran.exitCode, succeeded, ran.printed);
	assert.isFalse(Str.includes(callerOnly)(ran.printed), "a variable of the caller reached codex");
	assert.isTrue(has(`HOME=${where.home}`), ran.printed);
	assert.isTrue(has(`CODEX_HOME=${where.routedCodexHome}`), ran.printed);
}).pipe(Effect.scoped);

const repoDespiteCallerConfig = Effect.gen(function* repoDespiteCallerConfig() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const where = yield* place;
	const global = path.join(where.home, "caller.gitconfig");

	yield* fs.writeFileString(global, signsWithAFailingProgram);
	yield* fs.writeFileString(path.join(where.work, "notes.txt"), "The build runs at noon.");
	yield* inCaller("GIT_CONFIG_GLOBAL", global);

	return yield* Effect.exit(gitRepo(where));
}).pipe(Effect.scoped);

const madeDespiteCallerConfig = Effect.gen(function* madeDespiteCallerConfig() {
	const made = yield* repoDespiteCallerConfig;

	assert.isTrue(Exit.isSuccess(made), String(made));
});

it.layer(NodeServices.layer)("a wire run's codex", (test) => {
	test.effect(
		"gets a new empty home, two Codex homes and a working folder per place, gone with its scope",
		() => placesThenGone,
	);
	test.effect(
		"sees no variable of the caller's and a closed stdin, and its home and Codex home are the place's",
		() => keepsTheCallerOut,
		patient,
	);
	test.effect("makes its git repository with no git config of the caller's", () => madeDespiteCallerConfig, patient);
});
