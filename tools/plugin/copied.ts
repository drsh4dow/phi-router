import { Effect, FileSystem, Path } from "effect";
import { copyPrivately, writePrivately } from "#router/client/private-file.ts";
import { filePath } from "#tools/file-path.ts";

const pluginCopy = Effect.gen(function* pluginCopy() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-plugin-" });
	const copy = path.join(folder, "claude");

	yield* fs.copy(path.resolve(import.meta.dirname, "../../plugins/claude"), copy);

	return copy;
});

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

const piCli = decodeURIComponent(
	filePath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url)),
);

export { packageCopy, piCli, pluginCopy };
