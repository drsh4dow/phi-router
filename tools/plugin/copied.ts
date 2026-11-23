import { Effect, FileSystem, Path } from "effect";
import { copyPrivately, writePrivately } from "#router/client/private-file.ts";

/** A copy of `plugins/claude` alone in a fresh temp folder, as an install leaves it in Claude Code's cache. */
const pluginCopy = Effect.gen(function* pluginCopy() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-plugin-" });
	const copy = path.join(folder, "claude");

	yield* fs.copy(path.resolve(import.meta.dirname, "../../plugins/claude"), copy);

	return copy;
});

/**
 * A copy of the pi package, its `package.json` and `plugins/`, as `pi install` leaves it, in a fresh temp folder whose
 * name holds a space and an accent, as a user's home folder can.
 */
const packageCopy = Effect.gen(function* packageCopy() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi package é-" });
	const root = path.resolve(import.meta.dirname, "../..");

	const manifest = yield* fs.readFileString(path.join(root, "package.json"));

	yield* copyPrivately(path.join(root, "plugins"), path.join(folder, "plugins"));
	yield* writePrivately(path.join(folder, "package.json"), manifest);

	return folder;
});

export { packageCopy, pluginCopy };
