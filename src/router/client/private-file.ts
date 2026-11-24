import { Array, Effect, FileSystem, Order, Path, Random } from "effect";

/** Every file the router writes, and every folder it makes, is its user's alone. */
const privateModes = { file: 0o600, folder: 0o700 } as const;

/**
 * Writes `text` to a fresh temp file beside `file`, made 0600 in a folder made 0700, syncs it and renames it over
 * `file`, so a read sees the old file or the whole new one. The new file gets `mode` once it holds the whole text.
 */
const writePrivately = Effect.fnUntraced(function* writePrivately(
	file: string,
	text: string,
	mode: number = privateModes.file,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const temp = yield* Random.nextInt.pipe(Effect.map((unique) => `${file}.${String(unique)}.tmp`));

	yield* fs.makeDirectory(path.dirname(file), { mode: privateModes.folder, recursive: true });

	const handle = yield* fs.open(temp, { flag: "wx", mode: privateModes.file });

	yield* handle.writeAll(new TextEncoder().encode(text));
	yield* handle.sync;

	if (mode !== privateModes.file) {
		yield* fs.chmod(temp, mode);
	}

	yield* fs.rename(temp, file);
}, Effect.scoped);

/** Appends `text` to `file`, which is made 0600 in a folder made 0700 when it does not exist yet. */
const appendPrivately = Effect.fnUntraced(function* appendPrivately(file: string, text: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	yield* fs.makeDirectory(path.dirname(file), { mode: privateModes.folder, recursive: true });
	yield* fs.writeFileString(file, text, { flag: "a", mode: privateModes.file });
});

/** The permission bits of a file's mode, without its type. */
const permissions = 0o1000;

/**
 * Writes `text` over the file `file` resolves to, which is the file a symlink names when `file` is one, and keeps that
 * file's mode, as a harness's own writes do. A file that does not exist yet is made 0600.
 */
const rewritePrivately = Effect.fnUntraced(function* rewritePrivately(file: string, text: string) {
	const fs = yield* FileSystem.FileSystem;
	const exists = yield* fs.exists(file);

	if (!exists) {
		return yield* writePrivately(file, text);
	}

	const target = yield* fs.realPath(file);
	const info = yield* fs.stat(target);

	return yield* writePrivately(target, text, info.mode % permissions);
});

const ownerBits = { execute: 0o100, write: 0o200 } as const;

/**
 * The mode of a private copy of a file: 0700 when its owner may run the original, else 0600.
 *
 * @param {object} original The original's metadata.
 * @returns {number} The mode.
 */
const copyMode = (original: Readonly<Pick<FileSystem.File.Info, "mode">>): number => {
	if (original.mode % ownerBits.write >= ownerBits.execute) {
		return privateModes.folder;
	}

	return privateModes.file;
};

/**
 * Copies the folder `from` to `to`, which must not exist: each folder made 0700, and each file 0600, or 0700 when its
 * source is its owner's to run. Entries go in path order, so each folder exists before what it holds.
 */
const copyPrivately = Effect.fnUntraced(function* copyPrivately(from: string, to: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const listed = yield* fs.readDirectory(from, { recursive: true });
	const entries = Array.sort(listed, Order.String);

	yield* fs.makeDirectory(to, { mode: privateModes.folder, recursive: true });

	yield* Effect.forEach(
		entries,
		Effect.fnUntraced(function* copied(entry) {
			const info = yield* fs.stat(path.join(from, entry));

			if (info.type === "Directory") {
				return yield* fs.makeDirectory(path.join(to, entry), { mode: privateModes.folder, recursive: true });
			}

			const bytes = yield* fs.readFile(path.join(from, entry));

			return yield* fs.writeFile(path.join(to, entry), bytes, { flag: "wx", mode: copyMode(info) });
		}),
		{ concurrency: 1, discard: true },
	);
});

export { appendPrivately, copyPrivately, rewritePrivately, writePrivately };
