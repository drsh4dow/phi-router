import { ConfigProvider, Effect, Exit, Path, Struct } from "effect";
import { assert, it } from "@effect/vitest";
import { forPlatform, homeFolder } from "#router/client/platform.ts";

const choices = { posix: "posix", windows: "windows" } as const;

const windowsPath = Path.Path.pipe(Effect.map((posix) => Path.make(Struct.assign(posix, { sep: "\\" }))));

const onPath = Effect.fnUntraced(function* onPath(windows: boolean) {
	const posix = yield* Path.Path;

	if (windows) {
		return yield* windowsPath;
	}

	return posix;
});

const chosenOn = Effect.fnUntraced(function* chosenOn(windows: boolean) {
	const path = yield* onPath(windows);

	return yield* Effect.provideService(forPlatform(choices), Path.Path, path);
});

const homeUnder = Effect.fnUntraced(function* homeUnder(windows: boolean, env: Readonly<Record<string, string>>) {
	const path = yield* onPath(windows);
	const provider = ConfigProvider.fromEnv({ env });
	const home = Effect.provideService(homeFolder, ConfigProvider.ConfigProvider, provider);

	return yield* Effect.provideService(home, Path.Path, path);
});

const profile = String.raw`C:\Users\someone`;

const ownHome = String.raw`C:\Users\home`;

it.layer(Path.layer)("the platform", (test) => {
	test.effect("a choice is Windows only where paths are separated by a backslash", () =>
		Effect.gen(function* chosen() {
			const picked = yield* Effect.all({ posix: chosenOn(false), windows: chosenOn(true) }, { concurrency: 1 });

			assert.deepStrictEqual(picked, { posix: "posix", windows: "windows" });
		}),
	);

	test.effect("the home folder is HOME, and on Windows only a missing HOME falls back to USERPROFILE", () =>
		Effect.gen(function* homes() {
			const found = yield* Effect.all(
				{
					posix: homeUnder(false, { HOME: "/home/someone", USERPROFILE: profile }),
					windowsHome: homeUnder(true, { HOME: ownHome, USERPROFILE: profile }),
					windowsProfile: homeUnder(true, { USERPROFILE: profile }),
				},
				{ concurrency: 1 },
			);

			const posixWithoutHome = yield* Effect.exit(homeUnder(false, { USERPROFILE: profile }));

			assert.deepStrictEqual(found, { posix: "/home/someone", windowsHome: ownHome, windowsProfile: profile });
			assert.isTrue(Exit.isFailure(posixWithoutHome));
		}),
	);
});
