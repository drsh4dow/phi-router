import { Array, Effect, FileSystem, Order, Path, Struct } from "effect";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { copyPrivately } from "#router/client/private-file.ts";
import { pluginCopy } from "./copied.ts";

const permissions = 0o1000;
const octal = 8;

const modesIn = Effect.fnUntraced(function* modesIn(folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const entries = yield* fs.readDirectory(folder, { recursive: true });

	const infos = yield* Effect.forEach(entries, (entry) => fs.stat(path.join(folder, entry)), { concurrency: 1 });

	return Array.map(Array.zip(entries, infos), ([entry, info]) => {
		const mode = (info.mode % permissions).toString(octal);

		if (info.type === "Directory") {
			return `folder ${mode}`;
		}

		if (entry === path.join("bin", "phi-router")) {
			return `launcher ${mode}`;
		}

		return `file ${mode}`;
	});
});

const childrenFirst = Effect.gen(function* childrenFirst() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const source = yield* pluginCopy;
	const copy = path.join(path.dirname(source), "private");

	const reversed = Struct.assign(fs, {
		readDirectory: (folder: string, options?: { readonly recursive?: boolean }) =>
			Effect.map(fs.readDirectory(folder, options), Array.reverse),
	});

	yield* copyPrivately(source, copy).pipe(Effect.provideService(FileSystem.FileSystem, reversed));

	const original = yield* modesIn(source);
	const copied = yield* modesIn(copy);

	assert.deepStrictEqual(
		{ count: copied.length, kinds: Array.dedupe(Array.sort(copied, Order.String)) },
		{ count: original.length, kinds: ["file 600", "folder 700", "launcher 700"] },
		"every entry is copied, folders and the launcher at 0700 and every other file at 0600",
	);
});

it.layer(NodeServices.layer)("copyPrivately", (test) => {
	test.effect("copies a plugin privately even when the listing names a file before its folder", () => childrenFirst);
});
