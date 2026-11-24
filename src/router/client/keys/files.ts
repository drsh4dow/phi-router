import { Effect, Option, Path, Redacted } from "effect";
import { UserDirectories } from "effect/persistence";
import type { Vendor } from "#router/client/configuration/index.ts";
import { readKey } from "#router/client/accounts/index.ts";
import { writePrivately } from "#router/client/private-file.ts";

const keyFileOf = Effect.fnUntraced(
	function* keyFileOf(vendor: Vendor) {
		const directories = yield* UserDirectories.UserDirectories;
		const path = yield* Path.Path;
		const folder = yield* directories.config("phi-router");

		return path.join(folder, "keys", vendor);
	},
	Effect.provideService(UserDirectories.UserDirectories, UserDirectories.make()),
);

const savedKey = Effect.fnUntraced(function* savedKey(vendor: Vendor) {
	const keyFile = yield* keyFileOf(vendor);

	return yield* Effect.option(readKey({ keyFile }));
});

const saveKey = Effect.fnUntraced(function* saveKey(vendor: Vendor, key: Readonly<Redacted.Redacted>) {
	const saved = yield* savedKey(vendor);
	const keyFile = yield* keyFileOf(vendor);
	const same = Option.exists(saved, (held) => Redacted.value(held) === Redacted.value(key));

	if (!same) {
		yield* writePrivately(keyFile, `${Redacted.value(key)}\n`);
	}
});

export { keyFileOf, saveKey, savedKey };
