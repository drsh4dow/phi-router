import {
	Array,
	Config,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Path,
	Predicate,
	Record,
	Schema,
	Struct,
	pipe,
} from "effect";
import { behindDeadProxy, harnessFolder, harnessTurn } from "./turn.ts";
import { ChildProcess } from "effect/process";
import { rewritePrivately } from "#router/client/private-file.ts";

/** Claude Code's `settings.json`: a JSON object, every key of which a write keeps. */
const SettingsFile = Schema.fromJsonString(Schema.JsonObject, { space: 2 });

const Blocks = Schema.Struct({
	enabledPlugins: Schema.optionalKey(Schema.JsonObject),
	env: Schema.optionalKey(Schema.JsonObject),
});

/** Claude Code's `settings.json` is not a JSON object with an object `env` and `enabledPlugins`. It is left as it was. */
class SettingsUnread extends Schema.TaggedError<SettingsUnread, { readonly brand: unique symbol }>()("SettingsUnread", {
	cause: Schema.Defect(),
	path: Schema.String,
}) {
	public override get message(): string {
		return `phi-router cannot read ${this.path} as Claude Code settings, and left it as it was. Fix the file and run the command again.`;
	}
}

/** What the user's `settings.json` says that the router reads. A missing file or block reads as empty. */
interface UserSettings {
	readonly path: string;
	readonly env: Readonly<Record<string, string>>;
	/** The plugin ids `enabledPlugins` holds at `true`. */
	readonly enabledPlugins: readonly string[];
}

/**
 * One headless turn: its prompt, its model, the `env` block laid over Claude Code's settings for it alone, the plugin
 * folder it loads, and the environment the turn and its hooks get beside `PATH`.
 */
interface Asked {
	readonly prompt: string;
	readonly model: string;
	readonly settingsEnv: Readonly<Record<string, string>>;
	readonly plugin: string;
	readonly env: Readonly<Record<string, string>>;
}

const Installs = Schema.Array(Schema.Struct({ installPath: Schema.String }));

const InstalledPlugins = Schema.fromJsonString(Schema.Struct({ plugins: Schema.Record(Schema.String, Installs) }));

/** The login a headless turn sends, so no real login reaches the router or a mock. */
const fakeLogin = "phi-doctor-login";

/** Claude Code's config folder: `named`, else `CLAUDE_CONFIG_DIR`, else `.claude` under the home folder. */
const configFolder = harnessFolder({ fallback: ".claude", variable: "CLAUDE_CONFIG_DIR" });

/** The file `name` in the config folder. */
const fileOf = Effect.fnUntraced(function* fileOf(named: string, name: string) {
	const path = yield* Path.Path;
	const folder = yield* configFolder(named);

	return path.join(folder, name);
});

const settingsName = "settings.json";

/** The settings in `file`, every key kept, with their two blocks, or empty ones when there is no file. */
const read = Effect.fnUntraced(function* read(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const exists = yield* fs.exists(file);

	if (!exists) {
		return { blocks: {}, settings: {} };
	}

	const text = yield* fs.readFileString(file);

	return yield* Schema.decodeEffect(SettingsFile)(text).pipe(
		Effect.flatMap((settings) =>
			Schema.decodeEffect(Blocks)(settings).pipe(Effect.map((blocks) => ({ blocks, settings }))),
		),
		Effect.mapError((cause) => SettingsUnread.make({ cause, path: file })),
	);
});

/** What `settings.json` in the config folder holds. `named` is the folder the developer named, or empty. */
const userSettings = Effect.fnUntraced(function* userSettings(named: string) {
	const file = yield* fileOf(named, settingsName);
	const { blocks } = yield* read(file);
	const { enabledPlugins = {}, env = {} } = blocks;

	return {
		enabledPlugins: pipe(
			enabledPlugins,
			Record.filter((value) => value === true),
			Record.keys,
		),
		env: pipe(env, Record.filter(Predicate.isString)),
		path: file,
	} satisfies UserSettings;
});

/** The folder Claude Code installed the plugin `id` into, from `plugins/installed_plugins.json`, if it installed it. */
const claudePlugin = Effect.fnUntraced(function* claudePlugin(named: string, id: string) {
	const fs = yield* FileSystem.FileSystem;
	const file = yield* fileOf(named, "plugins/installed_plugins.json");
	const exists = yield* fs.exists(file);

	if (!exists) {
		return Option.none<string>();
	}

	const text = yield* fs.readFileString(file);

	const { plugins } = yield* Schema.decodeEffect(InstalledPlugins)(text).pipe(
		Effect.mapError((cause) => SettingsUnread.make({ cause, path: file })),
	);

	return pipe(
		Record.get(plugins, id),
		Option.flatMap(Array.head),
		Option.map(({ installPath }) => installPath),
	);
});

/**
 * Sets each of `set` in the `env` block of `settings.json`, removes each of `unset`, and keeps every other key. It
 * removes the block when that empties it. It returns the file's path and the names whose value it changed, and with
 * none changed it writes nothing and creates no file. It writes a temp file beside the target and renames it, so a
 * crash leaves the old file or the new one.
 */
const rewriteEnv = Effect.fnUntraced(function* rewriteEnv(
	named: string,
	set: Readonly<Record<string, string>>,
	unset: readonly string[],
) {
	const file = yield* fileOf(named, settingsName);
	const { blocks, settings } = yield* read(file);
	const env = blocks.env ?? {};

	const left = pipe(
		Struct.assign(env, set),
		Record.filter((_value, name) => !Array.contains(unset, name)),
	);

	const changed = pipe(
		[...Record.keys(set), ...unset],
		Array.filter((name) => env[name] !== left[name]),
	);

	const after = pipe(
		Option.liftPredicate(left, Predicate.not(Record.isEmptyRecord)),
		Option.match({
			onNone: () => Record.remove(settings, "env"),
			onSome: (kept) => Record.set(settings, "env", kept),
		}),
	);

	if (Array.isReadonlyArrayNonEmpty(changed)) {
		yield* Schema.encodeEffect(SettingsFile)(after).pipe(
			Effect.flatMap((text) => rewritePrivately(file, `${text}\n`)),
		);
	}

	return { changed, path: file };
});

/**
 * `claude -p` with a fake login in a fresh home and config folder, the one plugin in `asked.plugin`, a dead proxy, and
 * nothing of the caller's environment but `PATH`. It retries nothing, so a model address no router holds fails the turn
 * at once.
 */
const commandOf = Effect.fnUntraced(function* commandOf(asked: Asked) {
	const fs = yield* FileSystem.FileSystem;
	const searchPath = yield* Config.String("PATH");
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-home-" });
	const config = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-claude-" });
	const settings = Formatter.formatJson({ env: asked.settingsEnv });

	const args = ["-p", asked.prompt, "--model", asked.model, "--settings", settings, "--plugin-dir", asked.plugin];

	return ChildProcess.make("claude", args, {
		cwd: home,
		env: pipe(
			asked.env,
			Struct.assign(behindDeadProxy),
			Struct.assign({
				ANTHROPIC_AUTH_TOKEN: fakeLogin,
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				CLAUDE_CODE_MAX_RETRIES: "0",
				CLAUDE_CONFIG_DIR: config,
				HOME: home,
				PATH: searchPath,
			}),
		),
		extendEnv: false,
	});
});

/** Runs the installed `claude -p` once in a fresh home and config folder, and ends the turn after 2 minutes. */
const claudeTurn = harnessTurn(commandOf);

export { claudeTurn, claudePlugin, rewriteEnv, userSettings };

export type { UserSettings };
