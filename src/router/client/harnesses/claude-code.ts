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
	String as Str,
	Struct,
	pipe,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { behindDeadProxy, harnessFolder, harnessTurn } from "./turn.ts";
import { rewritePrivately, writePrivately } from "#router/client/private-file.ts";
import { rewritten } from "./codex.ts";

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

const Installs = Schema.Array(Schema.Struct({ installPath: Schema.String, version: Schema.String }));

const InstalledPlugins = Schema.fromJsonString(
	Schema.Struct({ plugins: Schema.Record(Schema.String, Schema.Unknown) }),
);

const fakeLogin = "phi-doctor-login";

const configFolder = harnessFolder({ fallback: ".claude", variable: "CLAUDE_CONFIG_DIR" });

const configFile = Effect.fnUntraced(function* configFile(named: string, name: string) {
	const path = yield* Path.Path;
	const folder = yield* configFolder(named);

	return path.join(folder, name);
});

const settingsName = "settings.json";

const knownMarketplacesName = "plugins/known_marketplaces.json";

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

	if (os === "win32") {
		return String.raw`C:\Program Files\ClaudeCode\managed-settings.json`;
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
		return Option.none<(typeof Installs.Type)[number]>();
	}

	const text = yield* fs.readFileString(file);

	const installs = yield* Schema.decodeEffect(InstalledPlugins)(text).pipe(
		Effect.flatMap(({ plugins }) => Schema.decodeUnknownEffect(Schema.UndefinedOr(Installs))(plugins[id])),
		Effect.mapError((cause) => SettingsUnread.make({ cause, path: file })),
	);

	return pipe(Option.fromUndefinedOr(installs), Option.flatMap(Array.head));
});

const asObject = Schema.decodeUnknownOption(Schema.JsonObject);

const claudeMarketplace = Effect.fnUntraced(function* claudeMarketplace(named: string, name: string) {
	const settingsFile = yield* configFile(named, settingsName);
	const knownFile = yield* configFile(named, knownMarketplacesName);
	const { settings } = yield* read(settingsFile);
	const { settings: known } = yield* read(knownFile);

	return {
		declared: pipe(
			asObject(settings["extraKnownMarketplaces"]),
			Option.flatMap((declared) => Option.fromUndefinedOr(declared[name])),
		),
		fetched: Option.fromUndefinedOr(known[name]),
	};
});

const followedMarketplace = Effect.fnUntraced(function* followedMarketplace(
	named: string,
	name: string,
	github: { readonly repo: string; readonly ref: string },
) {
	const settingsFile = yield* configFile(named, settingsName);
	const knownFile = yield* configFile(named, knownMarketplacesName);
	const source = { ref: github.ref, repo: github.repo, source: "github" };
	const encoded = Schema.encodeEffect(SettingsFile);
	const { settings: known } = yield* read(knownFile);
	const fetched = asObject(known[name]);

	if (Option.isNone(fetched)) {
		return;
	}

	const { settings } = yield* read(settingsFile);
	const declared = Option.getOrElse(asObject(settings["extraKnownMarketplaces"]), (): Schema.JsonObject => ({}));

	const entry = Struct.assign(
		Option.getOrElse(asObject(declared[name]), () => ({})),
		{ autoUpdate: true, source },
	);

	const followed = Record.set(settings, "extraKnownMarketplaces", Struct.assign(declared, { [name]: entry }));
	const refetched = Record.set(known, name, Struct.assign(fetched.value, { source }));
	const settingsBefore = yield* encoded(settings);
	const settingsAfter = yield* encoded(followed);
	const knownBefore = yield* encoded(known);
	const knownAfter = yield* encoded(refetched);

	yield* rewritten(settingsFile, settingsBefore, settingsAfter);
	yield* rewritten(knownFile, knownBefore, knownAfter);
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

const statusLineStatement = "statusLine";

const commandOfStatusLine = Schema.decodeUnknownOption(Schema.Struct({ command: Schema.String }));

const removeStatusLine = Effect.fnUntraced(function* removeStatusLine(named: string, command: string) {
	const file = yield* configFile(named, settingsName);
	const { settings } = yield* read(file);
	const ours = Option.exists(commandOfStatusLine(settings[statusLineStatement]), (line) => line.command === command);

	if (ours) {
		yield* Schema.encodeEffect(SettingsFile)(Record.remove(settings, statusLineStatement)).pipe(
			Effect.flatMap((text) => rewritePrivately(file, `${text}\n`)),
		);
	}

	return ours;
});

const Row = Schema.Struct({
	behavesAs: Schema.String,
	description: Schema.optionalKey(Schema.String),
	label: Schema.optionalKey(Schema.String),
	model: Schema.String,
});

type PickerRow = typeof Row.Type;

const modelPickerStatement = "modelPicker";

const Options = Schema.optionalKey(Schema.Array(Schema.Json));

const rowsOf = Schema.decodeUnknownOption(Schema.Struct({ options: Options }));

const ModelRow = Schema.Struct({ model: Schema.String });

const modelOf = Schema.decodeUnknownOption(ModelRow);

const pickModels = Effect.fnUntraced(function* pickModels(
	named: string,
	models: readonly string[],
	rows: readonly PickerRow[],
) {
	const file = yield* configFile(named, settingsName);
	const { settings } = yield* read(file);
	const picker = Option.getOrElse(asObject(settings[modelPickerStatement]), () => Record.empty<string, Schema.Json>());

	const decoded = rowsOf(picker);

	if (Option.isNone(decoded)) {
		return false;
	}

	const left = [
		...pipe(
			decoded.value.options ?? [],
			Array.filter((row) => !Option.exists(modelOf(row), ({ model }) => Array.contains(models, model))),
		),
		...rows,
	];

	const picked: Option.Option<Schema.Json> = Option.firstSomeOf([
		pipe(
			Option.liftPredicate(left, Array.isReadonlyArrayNonEmpty),
			Option.map((kept) => Struct.assign(picker, { options: kept })),
		),
		Option.liftPredicate(Record.remove(picker, "options"), Predicate.not(Record.isEmptyRecord)),
	]);

	const after = Option.match(picked, {
		onNone: () => Record.remove(settings, modelPickerStatement),
		onSome: (kept) => Record.set(settings, modelPickerStatement, kept),
	});

	const before = yield* Schema.encodeEffect(SettingsFile)(settings);
	const text = yield* Schema.encodeEffect(SettingsFile)(after);
	const changed = text !== before;

	if (changed) {
		yield* rewritePrivately(file, `${text}\n`);
	}

	return changed;
});

const claudePluginData = Effect.fnUntraced(function* claudePluginData(named: string, id: string) {
	return yield* configFile(named, `plugins/data/${Str.replaceAll(/[^\w-]/gu, "-")(id)}`);
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

const claudeVersion = Effect.gen(function* claudeVersion() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

	return yield* spawner.string(ChildProcess.make("claude", ["--version"], { stdin: "ignore" }));
});

export {
	claudeMarketplace,
	claudeTurn,
	claudePlugin,
	claudeVersion,
	claudePluginData,
	configFolder as claudeFolder,
	followedMarketplace,
	managedEnv,
	modelPickerStatement,
	pickModels,
	removeStatusLine,
	rewriteEnv,
	statusLineStatement,
	userSettings,
};

export type { PickerRow, UserSettings };
