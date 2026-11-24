import { Array, Config, ConfigProvider, Effect, FileSystem, Path, Record, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { gitServed, inEmptyTmp, place } from "./pi-run.ts";
import { NodeServices } from "@effect/platform-node";
import { TestClock } from "effect/testing";
import { ran } from "#tools/lifecycle/launched.ts";
import { succeeded } from "./checks.ts";

const patient = { timeout: 30_000 };

const awkward = "phi wire 'kept' $HOME\nfolder-";

const readsAndLeaves = ["sh", "-c", 'cat -- "$1/seen" && touch /tmp/leftover', "sh"];

const awkwardFolders = Effect.gen(function* awkwardFolders() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const outer = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: awkward });
	const kept = path.join(outer, `kept ${awkward}`);
	const home = path.join(outer, "home");

	yield* fs.makeDirectory(kept);
	yield* fs.makeDirectory(home);
	yield* fs.writeFileString(path.join(kept, "seen"), "bound back");

	return { home, kept };
});

const isolated = Effect.gen(function* isolated() {
	const { home, kept } = yield* awkwardFolders;
	const run = yield* inEmptyTmp([...readsAndLeaves, kept], home, [kept, home]);

	assert.deepStrictEqual({ exitCode: run.exitCode, left: run.left }, { exitCode: 0, left: ["leftover"] }, run.printed);
	assert.include(run.printed, "bound back");
}).pipe(Effect.scoped);

const probe = "phi-wire-probe";

const given = ["HOME", "PATH"];

const shellOwn = ["PWD", "OLDPWD", "SHLVL", "_"];

const probedPath = Effect.gen(function* probedPath() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const callerPath = yield* Config.String("PATH");
	const project = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "phi-wire-project-" });
	const tools = path.join(project, "node_modules", ".bin");

	yield* fs.makeDirectory(tools, { recursive: true });
	yield* fs.writeFileString(path.join(tools, probe), "#!/bin/sh\n", { mode: 0o755 });

	return { project, searchPath: `${tools}:${callerPath}` };
});

const userEnvironment = Effect.gen(function* userEnvironment() {
	const fs = yield* FileSystem.FileSystem;
	const { project, searchPath } = yield* probedPath;
	const home = yield* fs.makeTempDirectoryScoped();
	const user = ConfigProvider.fromEnv({ env: { PATH: searchPath } });
	const asUser = Effect.provideService(ConfigProvider.ConfigProvider, user);

	const found = yield* asUser(inEmptyTmp(["sh", "-c", `command -v ${probe}`], home, [project]));
	const listed = yield* asUser(inEmptyTmp(["env"], home, [project]));

	const names = pipe(
		Str.split(listed.printed, "\n"),
		Array.filter(Str.isNonEmpty),
		Array.map((line) => Array.headNonEmpty(Str.split(line, "="))),
	);

	assert.notInclude(found.printed, probe);
	assert.deepStrictEqual(Array.difference(names, [...given, ...shellOwn]), [], listed.printed);
}).pipe(Effect.scoped);

const freshPlaces = Effect.gen(function* freshPlaces() {
	const fs = yield* FileSystem.FileSystem;
	const one = yield* place;
	const two = yield* place;
	const folders = [...Record.values(one), ...Record.values(two)];
	const empty = [one.home, one.work, one.daemonBase, one.temporary, two.home, two.work, two.daemonBase, two.temporary];
	const entries = yield* Effect.forEach(empty, (folder) => fs.readDirectory(folder), { concurrency: "unbounded" });

	assert.lengthOf(pipe(folders, Array.dedupe), folders.length, String(folders));
	assert.isTrue(pipe(entries, Array.every(Array.isReadonlyArrayEmpty)), String(entries));
}).pipe(Effect.scoped);

const served = Effect.gen(function* served() {
	const where = yield* place;

	const whileOpen = yield* gitServed(where).pipe(
		Effect.flatMap((address) => Effect.map(ran(["git", "ls-remote", address], {}), (open) => ({ address, open }))),
		Effect.scoped,
	);

	const afterwards = yield* ran(["git", "ls-remote", whileOpen.address], {});

	assert.strictEqual(whileOpen.open.exitCode, succeeded, whileOpen.open.printed);
	assert.include(whileOpen.open.printed, "HEAD");
	assert.notStrictEqual(afterwards.exitCode, succeeded, afterwards.printed);
}).pipe(Effect.scoped, TestClock.withLive);

const unservable = Effect.gen(function* unservable() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const where = yield* place;
	const notAFolder = path.join(where.daemonBase, "file");

	yield* fs.writeFileString(notAFolder, "");

	const failure = yield* Effect.flip(Effect.scoped(gitServed({ daemonBase: notAFolder, home: where.home })));

	assert.match(String(failure), /^git init .* exited [1-9]/u);
}).pipe(Effect.scoped);

it.layer(NodeServices.layer)("the wire's empty /tmp", (test) => {
	test.effect(
		"binds back kept folders whose names hold a space, a quote, a $ and a newline, and names only what the command left",
		() => isolated,
		patient,
	);

	test.effect(
		"gives the command only HOME and a PATH with no node_modules/.bin folder in it",
		() => userEnvironment,
		patient,
	);
});

it.layer(NodeServices.layer)("pi's place", (test) => {
	test.effect("gives each place its own new folders, and all but the agent folder empty", () => freshPlaces);
});

it.layer(NodeServices.layer)("the git daemon pi installs from", (test) => {
	test.effect("serves the tree under test while its scope is open, and refuses once it ends", () => served, patient);

	test.effect("fails naming the git command that exited non-zero", () => unservable, patient);
});
