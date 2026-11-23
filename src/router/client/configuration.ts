import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { KeySource } from "./credentials.ts";
import { NoConfigFile } from "./no-config-file.ts";
import type { PlatformError } from "effect";
import { UserDirectories } from "effect/persistence";
import { realFolder } from "./processes.ts";

/** The file's `judge` block: a Decisions judge apart from the accounts, and its model when the block names one. */
interface NamedJudge {
	readonly endpoint: string;
	readonly key: KeySource;
	readonly model: Option.Option<string>;
}

/** What the router reads from the file beside the accounts. */
interface Configured {
	/** None when the file names no judge, so the judge runs on a BAA account. */
	readonly judge: Option.Option<NamedJudge>;
	/** The exact texts of parts that are never ruled on or judged. */
	readonly fixtures: readonly string[];
	/** The folders whose sessions run wholly on the sealed lane, each an absolute path, its real path when it exists. */
	readonly baaRepos: readonly string[];
}

const absent = Schema.optionalKey(Schema.Never);

const model = Schema.optionalKey(Schema.String);

/** Each BAA repo and each key file is an absolute path, since the router runs in another folder than the session. */
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

/** The file has no `mode`: the router has no shadow or trial mode, and a pin stands for a forced BAA mode. */
const File = Schema.fromJsonString(
	Schema.Struct({ baaRepos: BaaRepos, fixtures: Fixtures, judge: Schema.optionalKey(Named), mode: absent }),
);

/** `phi-router/config.json` under the XDG config folder. */
const configFile = Effect.gen(function* configFile() {
	const directories = yield* UserDirectories.UserDirectories;
	const path = yield* Path.Path;
	const folder = yield* directories.config("phi-router");

	return path.join(folder, "config.json");
});

/** The text of the configuration file. */
const configText = Effect.gen(function* configText() {
	const fs = yield* FileSystem.FileSystem;
	const file = yield* configFile;

	return yield* fs
		.readFileString(file)
		.pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.fail(NoConfigFile.make({ file }))));
});

/**
 * What `phi-router/config.json` under the XDG config folder says, read once when the layer is built. The file never
 * holds a key, only the key's source.
 */
class Configuration extends Context.Service<Configuration, Configured>()("phi-router/router/client/configuration") {
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

export { Configuration, absent, configFile, configText };
