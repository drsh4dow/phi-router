import { Array, Effect, FileSystem, Order, Path, Random } from "effect";

const privateModes = { file: 0o600, folder: 0o700 } as const;

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

const folderPrivately = Effect.fnUntraced(function* folderPrivately(folder: string) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.makeDirectory(folder, { mode: privateModes.folder, recursive: true });
});

const appendPrivately = Effect.fnUntraced(function* appendPrivately(file: string, text: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	yield* fs.makeDirectory(path.dirname(file), { mode: privateModes.folder, recursive: true });
	yield* fs.writeFileString(file, text, { flag: "a", mode: privateModes.file });
});

const permissionModulus = 0o1000;

const rewritePrivately = Effect.fnUntraced(function* rewritePrivately(file: string, text: string) {
	const fs = yield* FileSystem.FileSystem;
	const exists = yield* fs.exists(file);

	if (!exists) {
		return yield* writePrivately(file, text);
	}

	const target = yield* fs.realPath(file);
	const info = yield* fs.stat(target);

	return yield* writePrivately(target, text, info.mode % permissionModulus);
});

const ownerBits = { execute: 0o100, write: 0o200 } as const;

const copyMode = (original: Readonly<Pick<FileSystem.File.Info, "mode">>): number => {
	if (original.mode % ownerBits.write >= ownerBits.execute) {
		return privateModes.folder;
	}

	return privateModes.file;
};

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

export { appendPrivately, copyPrivately, folderPrivately, rewritePrivately, writePrivately };
