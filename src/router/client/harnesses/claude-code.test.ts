import { Array, ConfigProvider, Effect, FileSystem, Layer, Path, Record, Schema } from "effect";
import { assert, it } from "@effect/vitest";
import { managedEnv } from "./index.ts";

const places = {
	darwin: "/Library/Application Support/ClaudeCode/managed-settings.json",
	linux: "/etc/claude-code/managed-settings.json",
	win32: String.raw`C:\Program Files\ClaudeCode\managed-settings.json`,
} as const;

const settingsFor = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const managedPlaces = Layer.mergeAll(
	FileSystem.layerNoop({
		exists: (file) => Effect.succeed(Array.contains(Record.values(places), file)),
		readFileString: (file) => Effect.orDie(settingsFor({ env: { MANAGED_AT: file } })),
	}),
	Path.layer,
	ConfigProvider.layer(ConfigProvider.fromUnknown({})),
);

it.layer(managedPlaces)("Claude Code's managed settings", (test) => {
	test.effect("are read from Program Files on Windows, and from the same files as before on macOS and Linux", () =>
		Effect.gen(function* read() {
			const win32 = yield* managedEnv("win32");
			const darwin = yield* managedEnv("darwin");
			const linux = yield* managedEnv("linux");

			assert.deepStrictEqual(
				{ darwin, linux, win32 },
				{
					darwin: { MANAGED_AT: places.darwin },
					linux: { MANAGED_AT: places.linux },
					win32: { MANAGED_AT: places.win32 },
				},
			);
		}),
	);
});
