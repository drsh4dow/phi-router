import { Effect, FileSystem, Path } from "effect";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { inEmptyTmp } from "./pi-run.ts";

const patient = { timeout: 30_000 };

/** A folder name with each byte a shell string would split or expand: a space, a quote, a `$` and a newline. */
const awkward = "phi wire 'kept' $HOME\nfolder-";

/** Reads a file of a kept folder and leaves an entry in `/tmp`, from a command that takes the folder as an argument. */
const readsAndLeaves = ["sh", "-c", 'cat -- "$1/seen" && touch /tmp/leftover', "sh"];

/** A kept folder holding a file `seen`, and a home, both inside a folder of `/tmp` with an awkward name. */
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

it.layer(NodeServices.layer)("the wire's empty /tmp", (test) => {
	test.effect(
		"binds back kept folders whose names hold a space, a quote, a $ and a newline, and names only what the command left",
		() => isolated,
		patient,
	);
});
