import { Array, Effect, FileSystem, Path, pipe } from "effect";

const fileTypeBit = 0o1000;

const permissionsOf = (mode: number): number => mode % fileTypeBit;

const octal = 8;

const modes = { file: 0o600, folder: 0o700 } as const;

/**
 * Every path under each of `roots` as `<path> <mode in octal>`, and those of them that are not private: a folder with a
 * mode other than 0700, or a file with a mode other than 0600. The roots themselves are walked, not listed.
 */
const privacyUnder = Effect.fnUntraced(function* privacyUnder(roots: readonly string[]) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const under = Effect.fnUntraced(function* under(root: string) {
		const names = yield* fs.readDirectory(root, { recursive: true });

		return pipe(
			names,
			Array.map((name) => path.join(root, name)),
		);
	});

	const seenAt = Effect.fnUntraced(function* seenAt(named: string) {
		const info = yield* fs.stat(named);
		const shown = `${named} ${permissionsOf(info.mode).toString(octal)}`;

		if (info.type === "Directory") {
			return { isPrivate: permissionsOf(info.mode) === modes.folder, shown };
		}

		return { isPrivate: permissionsOf(info.mode) === modes.file, shown };
	});

	const listed = yield* Effect.forEach(roots, under, { concurrency: 1 });
	const seen = yield* Effect.forEach(Array.flatten(listed), seenAt, { concurrency: 1 });

	const notPrivate = pipe(
		seen,
		Array.filter(({ isPrivate }) => !isPrivate),
		Array.map(({ shown }) => shown),
	);

	return {
		notPrivate,
		shown: pipe(
			seen,
			Array.map(({ shown }) => shown),
		),
	};
});

export { privacyUnder };
