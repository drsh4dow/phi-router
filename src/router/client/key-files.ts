import { Effect, Option, Path, Redacted } from "effect";
import { UserDirectories } from "effect/persistence";
import type { Vendor } from "./lane-configuration.ts";
import { readKey } from "./credentials.ts";
import { writePrivately } from "./private-file.ts";

/** `phi-router/keys/<vendor>` under the XDG config folder, the file `setup` saves a pasted key in. */
const keyFileOf = Effect.fnUntraced(
	function* keyFileOf(vendor: Vendor) {
		const directories = yield* UserDirectories.UserDirectories;
		const path = yield* Path.Path;
		const folder = yield* directories.config("phi-router");

		return path.join(folder, "keys", vendor);
	},
	Effect.provideService(UserDirectories.UserDirectories, UserDirectories.make()),
);

/** The key saved for `vendor`, none when its file is missing or empty. */
const savedKey = Effect.fnUntraced(function* savedKey(vendor: Vendor) {
	const keyFile = yield* keyFileOf(vendor);

	return yield* Effect.option(readKey({ keyFile }));
});

/**
 * Saves `key` as `vendor`'s key file, 0600 in a 0700 folder, by a temp file renamed over it, and writes nothing when
 * the file holds that key already. The one writer of the key files.
 */
const saveKey = Effect.fnUntraced(function* saveKey(vendor: Vendor, key: Readonly<Redacted.Redacted>) {
	const saved = yield* savedKey(vendor);
	const keyFile = yield* keyFileOf(vendor);
	const same = Option.exists(saved, (held) => Redacted.value(held) === Redacted.value(key));

	if (!same) {
		yield* writePrivately(keyFile, `${Redacted.value(key)}\n`);
	}
});

export { keyFileOf, saveKey, savedKey };
