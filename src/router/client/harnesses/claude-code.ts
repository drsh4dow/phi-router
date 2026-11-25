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
import { rewritePrivately, writePrivately } from "#router/client/private-file.ts";
import { ChildProcess } from "effect/process";

const SettingsFile = Schema.fromJsonString(Schema.JsonObject, { space: 2 });

const Blocks = Schema.Struct({
	enabledPlugins: Schema.optionalKey(Schema.JsonObject),
	env: Schema.optionalKey(Schema.JsonObject),
});

class SettingsUnread extends Schema.TaggedError<SettingsUnread, { readonly brand: unique symbol }>()("SettingsUnread", {
	cause: Schema.Defect(),
	path: Schema.String,
}) {
	public override get message(): string {
		return `phi-router cannot read ${this.path} as Claude Code settings, and left it as it was. Fix the file and run the command again.`;
	}
}

interface UserSettings {
	readonly path: string;
	readonly env: Readonly<Record<string, string>>;
	readonly enabledPlugins: readonly string[];
}

interface Asked {
	readonly prompt: string;
	readonly model: string;
	readonly settingsEnv: Readonly<Record<string, string>>;
	readonly pluginFolder: string;
	readonly env: Readonly<Record<string, string>>;
}

const Installs = Schema.Array(Schema.Struct({ installPath: Schema.String }));

const InstalledPlugins = Schema.fromJsonString(Schema.Struct({ plugins: Schema.Record(Schema.String, Installs) }));

const fakeLogin = "phi-doctor-login";

const configFolder = harnessFolder({ fallback: ".claude", variable: "CLAUDE_CONFIG_DIR" });

const configFile = Effect.fnUntraced(function* configFile(named: string, name: string) {
	const path = yield* Path.Path;
	const folder = yield* configFolder(named);

	return path.join(folder, name);
});

const settingsName = "settings.json";

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

const userSettings = Effect.fnUntraced(function* userSettings(named: string) {
	const file = yield* configFile(named, settingsName);
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

const managedPlace = (os: string): string => {
	if (os === "darwin") {
		return "/Library/Application Support/ClaudeCode/managed-settings.json";
	}

	return "/etc/claude-code/managed-settings.json";
};

const managedEnv = Effect.fnUntraced(function* managedEnv(os: string) {
	const place = managedPlace(os);
	const file = yield* Config.String("PHI_ROUTER_CLAUDE_MANAGED_SETTINGS").pipe(Config.withDefault(place));
	const { blocks } = yield* read(file);

	return pipe(blocks.env ?? {}, Record.filter(Predicate.isString));
});

const claudePlugin = Effect.fnUntraced(function* claudePlugin(named: string, id: string) {
	const fs = yield* FileSystem.FileSystem;
	const file = yield* configFile(named, "plugins/installed_plugins.json");
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

const rewriteEnv = Effect.fnUntraced(function* rewriteEnv(
	named: string,
	set: Readonly<Record<string, string>>,
	unset: readonly string[],
) {
	const file = yield* configFile(named, settingsName);
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

const commandOf = Effect.fnUntraced(function* commandOf(asked: Asked) {
	const fs = yield* FileSystem.FileSystem;
	const searchPath = yield* Config.String("PATH");
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-home-" });
	const path = yield* Path.Path;
	const config = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-claude-" });

	yield* writePrivately(path.join(config, settingsName), Formatter.formatJson({ env: asked.settingsEnv }));

	const args = ["-p", asked.prompt, "--model", asked.model, "--plugin-dir", asked.pluginFolder];

	return ChildProcess.make("claude", args, {
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

const claudeTurn = harnessTurn(commandOf);

export { claudeTurn, claudePlugin, configFolder as claudeFolder, managedEnv, rewriteEnv, userSettings };

export type { UserSettings };
