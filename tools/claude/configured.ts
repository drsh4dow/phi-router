import { Effect, FileSystem, Schema, Struct } from "effect";
import { ran } from "#tools/lifecycle/launched.ts";

const routed = {
	ANTHROPIC_BASE_URL: "http://127.0.0.1:47411",
	ANTHROPIC_CUSTOM_MODEL_OPTION: "phi/auto",
	ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION:
		"An open account when a request is clean, a BAA account when it holds PHI",
	ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "PHI auto",
	CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1",
	DISABLE_ERROR_REPORTING: "1",
	DISABLE_FEEDBACK_COMMAND: "1",
	DISABLE_TELEMETRY: "1",
} as const;

const written = Struct.assign(routed, {
	PHI_ROUTER_WROTE_no_proxy: "127.0.0.1:47411",
	no_proxy: "127.0.0.1:47411",
});

const SettingsJson = Schema.fromJsonString(Schema.Json);

const entry = new URL("../../src/router/main.ts", import.meta.url).pathname;

interface ClaudeSettings {
	readonly enabledPlugins?: Readonly<Record<string, boolean>>;
	readonly env?: Readonly<Record<string, string>>;
	readonly model?: string;
	readonly permissions?: { readonly allow: readonly string[] };
}

const phiRouter = Effect.fnUntraced(function* phiRouter(
	args: readonly string[],
	env: Readonly<Record<string, string>>,
	runtime = "bun",
) {
	return yield* ran([runtime, entry, ...args], env);
});

const claudeIn = (dir: string): Readonly<Record<"on" | "off" | "doctor", readonly string[]>> => ({
	doctor: ["doctor", "claude", "--config-dir", dir],
	off: ["off", "claude", "--config-dir", dir],
	on: ["on", "claude", "--config-dir", dir],
});

const settingsFile = (dir: string): string => `${dir}/settings.json`;

const folder = Effect.fnUntraced(function* folder(prefix: string) {
	const fs = yield* FileSystem.FileSystem;

	return yield* fs.makeTempDirectoryScoped({ prefix });
});

const claudeFolders = Effect.gen(function* claudeFolders() {
	const home = yield* folder("phi-claude-home-");
	const dir = yield* folder("phi-claude-config-");

	return { dir, env: { CLAUDE_CONFIG_DIR: "", HOME: home, NO_PROXY: "", no_proxy: "" } };
});

const settingsIn = Effect.fnUntraced(function* settingsIn(dir: string) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(settingsFile(dir));

	return yield* Schema.decodeEffect(SettingsJson)(text);
});

const writeSettings = Effect.fnUntraced(function* writeSettings(dir: string, settings: ClaudeSettings) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* Schema.encodeUnknownEffect(SettingsJson)(settings);

	yield* fs.writeFileString(settingsFile(dir), text);
});

export type { ClaudeSettings };

export { claudeFolders, claudeIn, folder, phiRouter, routed, settingsFile, settingsIn, writeSettings, written };
