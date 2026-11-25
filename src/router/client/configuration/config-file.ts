import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { NoConfigFile } from "./no-config-file.ts";
import type { PlatformError } from "effect";
import { UserDirectories } from "effect/persistence";
import { realFolder } from "#router/client/processes.ts";

type KeySource = { readonly keyEnv: string } | { readonly keyCommand: string } | { readonly keyFile: string };

interface NamedJudge {
	readonly endpoint: string;
	readonly key: KeySource;
	readonly model: Option.Option<string>;
}

interface SettingsBesideLanes {
	readonly judge: Option.Option<NamedJudge>;
	readonly fixtures: readonly string[];
	readonly baaRepos: readonly string[];
}

const absent = Schema.optionalKey(Schema.Never);

const model = Schema.optionalKey(Schema.String);

const AbsolutePath = Schema.String.check(Schema.isPattern(/^\//u));

const KeyedByEnv = Schema.Struct({
	endpoint: Schema.String,
	keyCommand: absent,
	keyEnv: Schema.NonEmptyString,
	keyFile: absent,
	model,
});

const KeyedByCommand = Schema.Struct({
	endpoint: Schema.String,
	keyCommand: Schema.NonEmptyString,
	keyEnv: absent,
	keyFile: absent,
	model,
});

const KeyedByFile = Schema.Struct({
	endpoint: Schema.String,
	keyCommand: absent,
	keyEnv: absent,
	keyFile: AbsolutePath,
	model,
});

const Named = Schema.Union([KeyedByEnv, KeyedByCommand, KeyedByFile]);

const BaaRepos = Schema.optionalKey(Schema.Array(AbsolutePath));

const Fixtures = Schema.optionalKey(Schema.Array(Schema.NonEmptyString));

const File = Schema.fromJsonString(
	Schema.Struct({ baaRepos: BaaRepos, fixtures: Fixtures, judge: Schema.optionalKey(Named), mode: absent }),
);

const configFile = Effect.gen(function* configFile() {
	const directories = yield* UserDirectories.UserDirectories;
	const path = yield* Path.Path;
	const folder = yield* directories.config("phi-router");

	return path.join(folder, "config.json");
});

const configText = Effect.gen(function* configText() {
	const fs = yield* FileSystem.FileSystem;
	const file = yield* configFile;

	return yield* fs
		.readFileString(file)
		.pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.fail(NoConfigFile.make({ file }))));
});

const configuredJudge = Effect.gen(function* configuredJudge() {
	const fs = yield* FileSystem.FileSystem;
	const file = yield* Effect.provideService(configFile, UserDirectories.UserDirectories, UserDirectories.make());
	const exists = yield* fs.exists(file);

	if (!exists) {
		return Option.none<KeySource>();
	}

	const { judge } = yield* Effect.flatMap(fs.readFileString(file), Schema.decodeEffect(File));

	return Option.map(Option.fromUndefinedOr(judge), (named): KeySource => named);
});

class Configuration extends Context.Service<Configuration, SettingsBesideLanes>()(
	"phi-router/router/client/configuration/config-file/Configuration",
) {
	public static readonly layer: Layer.Layer<
		Configuration,
		NoConfigFile | PlatformError.PlatformError | Schema.SchemaError,
		FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
	> = Layer.effect(
		Configuration,
		Effect.gen(function* make() {
			const text = yield* configText;
			const { baaRepos = [], fixtures = [], judge } = yield* Schema.decodeEffect(File)(text);

			const realRepos = yield* Effect.forEach(baaRepos, realFolder, { concurrency: 1 });

			return Configuration.of({
				baaRepos: realRepos,
				fixtures,
				judge: Option.map(Option.fromUndefinedOr(judge), (named) => ({
					endpoint: named.endpoint,
					key: named,
					model: Option.fromUndefinedOr(named.model),
				})),
			});
		}),
	).pipe(Layer.provide(UserDirectories.layer));
}

export { Configuration, absent, configFile, configText, configuredJudge };

export type { KeySource };
