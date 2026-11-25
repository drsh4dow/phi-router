import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { isOlder } from "./release.ts";

const older: readonly (readonly [string, string])[] = [
	["0.4.0", "0.5.0"],
	["0.9.0", "0.10.0"],
	["0.5.0", "1.0.0"],
	["0.5.0-beta.1", "0.5.0"],
	["0.5.0-beta.1", "0.5.0-beta.2"],
	["0.5.0-beta.2", "0.5.0-beta.10"],
	["0.5.0-alpha", "0.5.0-beta"],
	["0.5.0-beta", "0.5.0-beta.1"],
	["0.5.0-1", "0.5.0-alpha"],
	["0.5.0-rc.1", "0.5.1-alpha"],
];

it.effect.each(older)("%s is older than %s, and not the other way", ([version, than]) =>
	Effect.sync(() => {
		assert.deepStrictEqual([isOlder(version, than), isOlder(than, version)], [true, false]);
	}),
);

it.effect.each(["0.5.0", "0.5.0-beta.2"])("%s is not older than itself", (version) =>
	Effect.sync(() => {
		assert.isFalse(isOlder(version, version));
	}),
);
