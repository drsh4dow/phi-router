import { Array, Effect, FileSystem, Option, Path } from "effect";

/**
 * The phi-router package `file` belongs to: the nearest folder above it that holds `plugins/claude/phi-router.mjs`, as
 * a checkout or an installed package does. None when no folder above it does.
 */
const packageOf = Effect.fnUntraced(function* packageOf(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const folders = Array.unfold(path.dirname(file), (folder) =>
		Option.liftPredicate([folder, path.dirname(folder)] as const, ([, above]) => above !== folder),
	);

	const roots = yield* Effect.filter(
		folders,
		(folder) => fs.exists(path.join(folder, "plugins", "claude", "phi-router.mjs")),
		{ concurrency: 1 },
	);

	return Array.head(roots);
});

export { packageOf };
