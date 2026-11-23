import { Array, Effect, FileSystem, Option, Path, Schema } from "effect";

const Manifest = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

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

/** The version in the `package.json` of the phi-router package `file` belongs to. */
const versionOf = Effect.fnUntraced(function* versionOf(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* Effect.flatMap(packageOf(file), Effect.fromOption);
	const text = yield* fs.readFileString(path.join(root, "package.json"));
	const { version } = yield* Schema.decodeEffect(Manifest)(text);

	return version;
});

export { packageOf, versionOf };
