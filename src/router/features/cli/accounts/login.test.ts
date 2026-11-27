import { ConfigProvider, Effect } from "effect";
import { assert, it } from "@effect/vitest";
import { Platform } from "#router/features/cli/platform.ts";
import { opensBrowser } from "./index.ts";

const platformOf = (os: string): Platform["Service"] => Platform.of({ entry: "/phi-router/main.js", name: "node", os });

const opensOn = (os: string, env: Readonly<Record<string, string>>): Effect.Effect<boolean> =>
	opensBrowser.pipe(
		Effect.provideService(Platform, platformOf(os)),
		Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
		Effect.orDie,
	);

const cases = [
	{ env: {}, os: "win32" },
	{ env: {}, os: "darwin" },
	{ env: {}, os: "linux" },
	{ env: { DISPLAY: ":0" }, os: "linux" },
	{ env: { BROWSER: "firefox" }, os: "linux" },
] as const;

it.effect(
	"a browser opens on Windows and macOS with no display variable, and elsewhere only with BROWSER, DISPLAY or WAYLAND_DISPLAY",
	() =>
		Effect.gen(function* browsers() {
			const seen = yield* Effect.forEach(cases, ({ env, os }) => opensOn(os, env), { concurrency: 1 });

			assert.deepStrictEqual(seen, [true, true, false, true, true]);
		}),
);
