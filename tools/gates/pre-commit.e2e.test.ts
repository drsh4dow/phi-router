import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Effect, FileSystem, Path, Stream } from "effect";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";

interface Commit {
	readonly name: string;
	readonly staged: string;
	readonly unstaged: string;
	readonly refused: boolean;
}

const formatted = "export const lane = 1;\n";

const misformatted = "export const  lane =1\n";

const linted = "debugger;\n";

const lintConfig = '{ "rules": { "no-debugger": "error" } }\n';

const commits: readonly Commit[] = [
	{
		name: "misformatted staged file under a formatted working copy",
		refused: true,
		staged: misformatted,
		unstaged: formatted,
	},
	{
		name: "formatted staged file under a misformatted working copy",
		refused: false,
		staged: formatted,
		unstaged: misformatted,
	},
	{ name: "staged lint error under a clean working copy", refused: true, staged: linted, unstaged: formatted },
];

const clean = 0;

const patient = { timeout: 60_000 };

const repo = Effect.gen(function* repo() {
	const path = yield* Path.Path;

	return path.resolve(import.meta.dirname, "../..");
});

const run = Effect.fn("run")(function* run(folder: string, command: string, args: readonly string[]) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd: folder }));
	const output = yield* Stream.mkString(Stream.decodeText(handle.all));
	const exitCode = yield* handle.exitCode;

	return { exitCode, output };
}, Effect.scoped);

const repository = Effect.gen(function* repository() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* repo;
	const tree = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-hook-" });

	yield* run(tree, "git", ["init", "-q"]);
	yield* fs.symlink(path.join(root, "node_modules"), path.join(tree, "node_modules"));
	yield* fs.copy(path.join(root, ".oxfmtrc.json"), path.join(tree, ".oxfmtrc.json"));
	yield* fs.writeFileString(path.join(tree, ".oxlintrc.json"), lintConfig);
	yield* fs.makeDirectory(path.join(tree, "src"));

	return tree;
});

const committing = Effect.fn("committing")(function* committing(commit: Commit) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* repo;
	const tree = yield* repository;
	const file = path.join(tree, "src", "lane.ts");

	yield* fs.writeFileString(file, commit.staged);
	yield* run(tree, "git", ["add", "src/lane.ts", ".oxfmtrc.json", ".oxlintrc.json"]);
	yield* fs.writeFileString(file, commit.unstaged);

	return yield* run(tree, "sh", [path.join(root, ".githooks", "pre-commit")]);
});

it.layer(NodeServices.layer)("the pre-commit hook checks what the commit holds", (test) => {
	test.effect.each(commits)(
		"$name",
		(commit) =>
			Effect.gen(function* hooked() {
				const { exitCode, output } = yield* committing(commit);

				assert.strictEqual(exitCode !== clean, commit.refused, output);
			}).pipe(Effect.scoped),
		patient,
	);
});
