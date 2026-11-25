import { Effect, Option, Path, Redacted } from "effect";
import { folderPrivately, writePrivately } from "#router/client/private-file.ts";
import { UserDirectories } from "effect/persistence";
import type { Vendor } from "#router/client/configuration/index.ts";
import { readKey } from "#router/client/accounts/index.ts";

const ownPath = Effect.fnUntraced(
	function* ownPath(names: readonly string[]) {
		const directories = yield* UserDirectories.UserDirectories;
		const path = yield* Path.Path;
		const folder = yield* directories.config("phi-router");

		return path.join(folder, ...names);
	},
	Effect.provideService(UserDirectories.UserDirectories, UserDirectories.make()),
);

const keyFileOf = Effect.fnUntraced(function* keyFileOf(vendor: Vendor) {
	return yield* ownPath(["keys", vendor]);
});

const pastedKeyFileOf = Effect.fnUntraced(function* pastedKeyFileOf(vendor: Vendor) {
	return yield* ownPath(["keys", "pasted", vendor]);
});

const loginFolderOf = Effect.fnUntraced(function* loginFolderOf(name: string) {
	const folder = yield* ownPath(["logins", name]);

	yield* folderPrivately(folder);

	return folder;
});

const keyIn = Effect.fnUntraced(function* keyIn(keyFile: string) {
	return yield* Effect.option(readKey({ keyFile }));
});

const keyWritten = Effect.fnUntraced(function* keyWritten(keyFile: string, key: Readonly<Redacted.Redacted>) {
	const held = yield* keyIn(keyFile);
	const same = Option.exists(held, (kept) => Redacted.value(kept) === Redacted.value(key));

	if (!same) {
		yield* writePrivately(keyFile, `${Redacted.value(key)}\n`);
	}
});

const savedKey = Effect.fnUntraced(function* savedKey(vendor: Vendor) {
	return yield* Effect.flatMap(keyFileOf(vendor), keyIn);
});

const saveKey = Effect.fnUntraced(function* saveKey(vendor: Vendor, key: Readonly<Redacted.Redacted>) {
	yield* Effect.flatMap(keyFileOf(vendor), (keyFile) => keyWritten(keyFile, key));
});

const pastedKey = Effect.fnUntraced(function* pastedKey(vendor: Vendor) {
	return yield* Effect.flatMap(pastedKeyFileOf(vendor), keyIn);
});

const savePastedKey = Effect.fnUntraced(function* savePastedKey(vendor: Vendor, key: Readonly<Redacted.Redacted>) {
	yield* Effect.flatMap(pastedKeyFileOf(vendor), (keyFile) => keyWritten(keyFile, key));
});

export { keyFileOf, keyWritten as saveToken, loginFolderOf, pastedKey, saveKey, savePastedKey, savedKey };
