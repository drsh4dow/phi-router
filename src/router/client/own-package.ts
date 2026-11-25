import { Array, Effect, FileSystem, Option, Path, Schema, pipe } from "effect";

const Manifest = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

const foldersAbove = Effect.fnUntraced(function* foldersAbove(file: string) {
	const path = yield* Path.Path;

	return Array.unfold(path.dirname(file), (folder) =>
		Option.liftPredicate([folder, path.dirname(folder)] as const, ([, above]) => above !== folder),
	);
});

const firstHolding = Effect.fnUntraced(function* firstHolding(file: string, inside: readonly string[]) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folders = yield* foldersAbove(file);

	const holding = yield* Effect.filter(folders, (folder) => fs.exists(path.join(folder, ...inside)), {
		concurrency: 1,
	});

	return Array.head(holding);
});

const packageOf = (file: string): ReturnType<typeof firstHolding> =>
	firstHolding(file, ["plugins", "claude", "phi-router.mjs"]);

const pluginManifest = [".claude-plugin", "plugin.json"] as const;

const versionOf = Effect.fnUntraced(function* versionOf(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const plugin = yield* firstHolding(file, pluginManifest);
	const root = yield* packageOf(file);

	const manifest = yield* pipe(
		plugin,
		Option.map((folder) => path.join(folder, ...pluginManifest)),
		Option.orElse(() =>
			pipe(
				root,
				Option.map((folder) => path.join(folder, "package.json")),
			),
		),
		Effect.fromOption,
	);

	const { version } = yield* fs.readFileString(manifest).pipe(Effect.flatMap(Schema.decodeEffect(Manifest)));

	return version;
});

export { packageOf, versionOf };
