import { Array, Config, Effect, Option, Record, Redacted, String as Str, pipe } from "effect";
import type { FoundKey } from "./copy.ts";
import type { Vendor } from "#router/client/configuration/index.ts";
import { keyVariables } from "./copy.ts";
import { savedKey } from "#router/client/keys/index.ts";
import { storedKey } from "#router/client/harnesses/index.ts";
import { tokenKindOf } from "#router/features/cli/accounts/index.ts";

const envKey = Effect.fnUntraced(function* envKey(vendor: Vendor) {
	const value = yield* Config.String(keyVariables[vendor]).pipe(Config.withDefault(""));

	return Str.isNonEmpty(Str.trim(value));
});

const piKey = Effect.fnUntraced(function* piKey(vendor: Vendor) {
	const stored = yield* storedKey(vendor);

	return Option.exists(stored, (key) =>
		Option.exists(tokenKindOf(Redacted.value(key)), (kind) => kind.scheme === "apiKey" && kind.vendor === vendor),
	);
});

const machineKeys = Effect.fnUntraced(function* machineKeys(vendor: Vendor) {
	const held = yield* Effect.all(
		{ env: envKey(vendor), pi: piKey(vendor), saved: Effect.map(savedKey(vendor), Option.isSome) },
		{ concurrency: 1 },
	);

	return pipe(
		Record.toEntries(held),
		Array.filter(([, found]) => found),
		Array.map(([place]): FoundKey => ({ place, vendor })),
	);
});

export { machineKeys };
