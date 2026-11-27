import { Array, Effect, Exit, FileSystem, Layer, Path, PlatformError, Schema, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/process";
import { Configuration } from "./index.ts";

const judge = { endpoint: "http://127.0.0.1:9/v1" };

const noShell = Layer.succeed(
	ChildProcessSpawner.ChildProcessSpawner,
	ChildProcessSpawner.make(() =>
		Effect.fail(PlatformError.badArgument({ description: "no shell here", method: "spawn", module: "ChildProcess" })),
	),
);

const textOf = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const holding = (text: string): Layer.Layer<FileSystem.FileSystem> =>
	FileSystem.layerNoop({ readFileString: () => Effect.succeed(text) });

const loads = Effect.fnUntraced(function* loads(text: string) {
	const configuration = Layer.provide(Configuration.layer, Layer.merge(holding(text), noShell));
	const built = yield* Effect.exit(Effect.scoped(Layer.build(configuration)));

	return Exit.isSuccess(built);
});

const loadsEach = Effect.fnUntraced(function* loadsEach(places: readonly string[]) {
	const files = pipe(
		places,
		Array.flatMap((place): readonly Schema.Json[] => [
			{ baaRepos: [place] },
			{ judge: { endpoint: judge.endpoint, keyFile: place } },
		]),
	);

	const texts = yield* Effect.orDie(Effect.forEach(files, (file) => textOf(file), { concurrency: 1 }));

	return yield* Effect.forEach(texts, loads, { concurrency: 1 });
});

const windowsAbsolute = [String.raw`C:\Users\u\phi-repo`, "D:/phi-repo", String.raw`\\host\share\phi-repo`];

const windowsRelative = [String.raw`phi-repo\x`, "C:phi-repo", String.raw`\phi-repo`];

it.layer(Path.layer)("the configuration file", (test) => {
	test.effect(
		"takes a Windows drive or UNC BAA repo and judge key file, refuses a Windows relative or drive-relative one, and keeps the POSIX rule",
		() =>
			Effect.gen(function* windowsPaths() {
				const windows = yield* loadsEach(windowsAbsolute);
				const relative = yield* loadsEach(windowsRelative);
				const posix = yield* loadsEach(["/home/u/phi-repo", "phi-repo"]);

				assert.deepStrictEqual(
					{ posix, relative, windows },
					{
						posix: [true, true, false, false],
						relative: [false, false, false, false, false, false],
						windows: [true, true, true, true, true, true],
					},
				);
			}),
	);
});
