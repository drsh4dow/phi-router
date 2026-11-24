import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Effect, FileSystem, Path, Stream } from "effect";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";

interface Gate {
	readonly fixture: string;
	readonly messages: readonly string[];
	readonly script: string;
}

const linked = ["node_modules", "tools/oxlint", "tools/ast-grep"];

const copied = [
	"src",
	"package.json",
	"tsconfig.json",
	".oxlintrc.jsonc",
	"oxlint-effect.json",
	".dependency-cruiser.json",
	"sgconfig.yml",
];

const gates: readonly Gate[] = [
	{
		fixture: "boundaries",
		messages: [
			"error runtime-to-runtime: ",
			"error shared-imports: src/shared/reexports.ts",
			"error router-entry-imports: src/router/main.test.ts",
			"error pi-entry-imports: ",
			"error feature-imports: ",
			"error cli-writes-through-the-router: src/router/features/cli/writes-store.ts",
			"error policy-imports: src/router/features/policy/reaches-client.test.ts",
			"error policy-imports: src/router/features/policy/reaches-vendor-types.ts",
			"error policy-imports: src/router/features/policy/harness/reexports-pi-types.ts",
			"error client-imports: src/router/client/store.test.ts",
			"error primitives-imports: ",
			"error production-imports-test: ",
			"error vitest-in-tests: ",
			"error http-owner: src/shared/reexports.ts",
			"error http-owner: src/pi/features/sample/http.ts",
			"error process-owner: src/shared/reexports.ts",
			"error disk-owner: src/shared/reexports.ts",
			"error config-writer: src/router/features/route/writes-config.ts",
			"error config-writer: src/router/features/route/loads-config-writer.ts",
			"error config-writer: src/router/client/reexports-writer.ts",
			"error runtime-owner: ",
			"error platform-owner: ",
			"error builtins: ",
			"error entry-builtins: src/router/main.ts",
			"error vendor-sdk: ",
			"error package-reexport: src/router/client/reexports.ts",
			"error tools-imports: ",
			"error pi-types: ",
			"error unmapped-source: src/router/unmapped.ts",
			"error unmapped-source: src/router/features/other/view.tsx",
			"reach the router from pi through",
		],
		script: "boundaries",
	},
	{
		fixture: "bans",
		messages: [
			"Return the Effect. The entry file, src/router/main.ts or src/pi/index.ts, runs it.",
			"The entry file, src/router/main.ts or src/pi/index.ts, detects the runtime.",
			"Disk belongs to src/router/client/.",
			"effect/cli reads the arguments, and Config reads the environment.",
			"Hash with Digest from effect/crypto.",
			"Use Console from effect, or Effect.log.",
			"Decode and encode with Schema.fromJsonString.",
			"Use Clock.currentTimeMillis or DateTime.now.",
			"Use Effect.sleep or Schedule. Tests move time with TestClock.",
			"HTTP belongs to src/router/client/.",
			"src/pi/features/sample/index.ts",
			"src/shared/sample.ts",
		],
		script: "lint",
	},
	{
		fixture: "bans-owners",
		messages: [
			"src/router/main.ts",
			"src/router/client/sample.ts",
			"src/pi/client/router.ts",
			"src/pi/index.ts",
			"Return the Effect. The entry file, src/router/main.ts or src/pi/index.ts, runs it.",
			"The entry file, src/router/main.ts or src/pi/index.ts, detects the runtime.",
			"Disk belongs to src/router/client/.",
			"effect/cli reads the arguments, and Config reads the environment.",
			"HTTP belongs to src/router/client/.",
		],
		script: "lint",
	},
	{
		fixture: "comments",
		messages: ["Delete this comment.", "src/router/features/sample/narration.ts"],
		script: "comments",
	},
	{
		fixture: "identifier-kinds",
		messages: [
			"What counts as PHI lives in src/router/features/policy/. Import its index.ts.",
			"src/router/features/sample/index.ts",
			"src/router/client/sample.ts:1:",
			"src/router/client/sample.ts:3:",
		],
		script: "comments",
	},
	{
		fixture: "live-bounds",
		messages: [
			"A unit test bounds nothing by the real clock",
			"src/router/features/sample/bounded.test.ts:5:",
			"src/router/features/sample/bounded.test.ts:7:",
			"src/router/features/sample/bounded.test.ts:10:",
			"src/router/features/sample/bounded.test.ts:13:",
		],
		script: "comments",
	},
	{
		fixture: "private-writes",
		messages: [
			"Write files and make folders through src/router/client/private-file.ts",
			"src/router/client/settings-writer.ts:6:",
			"src/router/client/settings-writer.ts:7:",
			"src/router/client/settings-writer.ts:8:",
			"src/pi/client/spellings.ts:5:",
			"src/pi/client/spellings.ts:6:",
			"src/pi/client/spellings.ts:7:",
			"src/pi/client/spellings.ts:9:",
		],
		script: "comments",
	},
	{
		fixture: "suppressions",
		messages: [
			"src/router/features/sample/index.ts:1:",
			"src/router/features/sample/index.ts:3:",
			"Fix the code the rule caught.",
		],
		script: "suppressions",
	},
];

/** Files on the paths the map prescribes, which no gate may reject. */
const prescribed = ["lint", "boundaries"];

const clean = 0;

const patient = { timeout: 120_000 };

/** Copies the repository's source tree and gate configs into a fresh folder. */
const mirror = Effect.fn("mirror")(function* mirror() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const repo = path.resolve(import.meta.dirname, "../..");
	const tree = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-gate-" });

	yield* fs.makeDirectory(path.join(tree, "tools"));

	yield* Effect.forEach(linked, (name) => fs.symlink(path.join(repo, name), path.join(tree, name)), {
		concurrency: 1,
	});

	yield* Effect.forEach(copied, (name) => fs.copy(path.join(repo, name), path.join(tree, name)), {
		concurrency: 1,
	});

	return tree;
});

/** Runs one package script in a tree, and returns its exit code and everything it printed. */
const run = Effect.fn("run")(function* run(tree: string, script: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const handle = yield* spawner.spawn(ChildProcess.make("bun", ["run", script], { cwd: tree }));
	const output = yield* Stream.mkString(Stream.decodeText(handle.all));
	const exitCode = yield* handle.exitCode;

	return { exitCode, output };
}, Effect.scoped);

it.layer(NodeServices.layer)("the gates", (test) => {
	test.effect.each(gates)(
		"the $script script passes the repository and fails once the $fixture fixture is copied in",
		(gate) =>
			Effect.gen(function* rejected() {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const tree = yield* mirror();
				const before = yield* run(tree, gate.script);

				assert.strictEqual(before.exitCode, clean, before.output);

				yield* fs.copy(path.join(import.meta.dirname, "fixtures", gate.fixture), tree, { overwrite: true });

				const after = yield* run(tree, gate.script);

				assert.notStrictEqual(after.exitCode, clean);

				for (const message of gate.messages) {
					assert.include(after.output, message);
				}
			}),
		patient,
	);

	test.effect.each(prescribed)(
		"the %s script passes the files the map prescribes",
		(script) =>
			Effect.gen(function* accepted() {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const tree = yield* mirror();

				yield* fs.copy(path.join(import.meta.dirname, "fixtures", "prescribed"), tree, { overwrite: true });

				const after = yield* run(tree, script);

				assert.strictEqual(after.exitCode, clean, after.output);
			}),
		patient,
	);
});
