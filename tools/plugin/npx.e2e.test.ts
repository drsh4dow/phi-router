import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Effect, FileSystem, Path, Stream, Struct } from "effect";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { filePath } from "#tools/file-path.ts";
import manifest from "#package.json" with { type: "json" };
import { ran } from "#tools/lifecycle/launched.ts";

const patient = { timeout: 120_000 };

const succeeded = 0;

const repository = filePath(new URL("../..", import.meta.url));

interface UserShell {
	readonly name: string;
	readonly shell: true | string;
}

const userShells = (): readonly UserShell[] => {
	if (process.platform === "win32") {
		return [
			{ name: "cmd.exe", shell: true },
			{ name: "PowerShell", shell: "powershell.exe" },
		];
	}

	return [{ name: "sh", shell: true }];
};

interface Typed {
	readonly line: string;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
}

const typed = Effect.fnUntraced(function* typed({ shell }: UserShell, { cwd, env, line }: Typed) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const handle = yield* spawner.spawn(ChildProcess.make(line, { cwd, env, extendEnv: true, shell }));
	const printed = yield* Stream.mkString(Stream.decodeText(Stream.merge(handle.stdout, handle.stderr)));
	const exitCode = yield* handle.exitCode;

	return { exitCode: Number(exitCode), printed };
}, Effect.scoped);

const npx = Effect.fnUntraced(function* npx(userShell: UserShell) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-npx-" });
	const npm = { npm_config_cache: path.join(folder, "cache"), npm_config_update_notifier: "false" };

	const pack = yield* typed(userShell, {
		cwd: repository,
		env: Struct.assign(npm, { npm_config_pack_destination: folder }),
		line: "npm pack --ignore-scripts",
	});

	assert.strictEqual(pack.exitCode, succeeded, pack.printed);

	const tarball = path.join(folder, `${manifest.name}-${manifest.version}.tgz`);

	const run = yield* typed(userShell, {
		cwd: folder,
		env: Struct.assign(npm, { npm_config_package: tarball, npm_config_yes: "true" }),
		line: "npx phi-router",
	});

	assert.deepStrictEqual(run, { exitCode: 0, printed: "phi-router runs on the bun platform layer\n" });
}, Effect.scoped);

const underNode = Effect.gen(function* underNode() {
	const path = yield* Path.Path;

	const run = yield* ran(["node", path.join(repository, manifest.bin["phi-router"])], {});

	assert.deepStrictEqual(run, { exitCode: 0, printed: "phi-router runs on the bun platform layer\n" });
});

it.layer(NodeServices.layer)("the npm package", (test) => {
	test.effect.each(userShells())("runs npx phi-router from $name, as a user types it", npx, patient);
	test.effect("starts its bin under node, as npm's Windows shim does", () => underNode, patient);
});
