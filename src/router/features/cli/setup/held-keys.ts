import { Array, Config, Console, Effect, Option, Redacted, String as Str, pipe } from "effect";
import type { Filler, Roles } from "./plan.ts";
import type { KeySource, Vendor } from "#router/client/configuration/index.ts";
import { keyFileOf, saveKey, savedKey as savedKeyOf } from "#router/client/keys/index.ts";
import { keyVariables, shown, vendorNames } from "./copy.ts";
import { misfitOf, refusalOf, stopped } from "./keys.ts";
import type { Signed } from "./sign-ins.ts";
import { keyNamed } from "./plan.ts";
import { storedKey } from "#router/client/harnesses/index.ts";

type KeyFiller = Extract<Filler, { kind: "key" }>;

type Typed = Readonly<Partial<Record<Vendor, Readonly<Redacted.Redacted>>>>;

const isKey = (filler: Filler): filler is KeyFiller => filler.kind === "key";

const keyFillers = (roles: Roles): readonly KeyFiller[] =>
	pipe(
		[roles.baa, roles.judge],
		Array.filter(isKey),
		Array.dedupeWith((one, other) => one.vendor === other.vendor && one.place === other.place),
	);

const valueOf = Effect.fnUntraced(function* valueOf(filler: KeyFiller, typed: Typed) {
	if (filler.place === "env") {
		return yield* Config.Redacted(keyVariables[filler.vendor]);
	}

	if (filler.place === "pi") {
		return yield* Effect.flatMap(storedKey(filler.vendor), Effect.fromOption);
	}

	if (filler.place === "saved") {
		return yield* Effect.flatMap(savedKeyOf(filler.vendor), Effect.fromOption);
	}

	return yield* Effect.fromOption(Option.fromUndefinedOr(typed[filler.vendor]));
});

const checkedKey = Effect.fnUntraced(function* checkedKey(title: string, filler: KeyFiller, typed: Typed) {
	const unread = stopped(`Setup could not read the ${shown(keyNamed(filler))}. Nothing changed.`);
	const key = yield* Effect.mapError(valueOf(filler, typed), () => unread);
	const misfit = misfitOf({ ask: { harnessTitle: title, vendor: filler.vendor }, key: Str.trim(Redacted.value(key)) });

	if (Option.isSome(misfit)) {
		return yield* stopped(misfit.value);
	}

	const refusal = yield* refusalOf(filler.vendor, key);

	if (Option.isSome(refusal)) {
		return yield* stopped(refusal.value);
	}

	yield* Console.log(`✓ ${vendorNames[filler.vendor]} key works`);

	return key;
});

const checkedKeys = Effect.fnUntraced(function* checkedKeys(title: string, roles: Roles, typed: Typed) {
	yield* Effect.forEach(keyFillers(roles), (filler) => checkedKey(title, filler, typed), {
		concurrency: 1,
		discard: true,
	});
});

const sourceOf = Effect.fnUntraced(function* sourceOf(filler: KeyFiller, typed: Typed) {
	if (filler.place === "env") {
		return { keyEnv: keyVariables[filler.vendor] } satisfies KeySource;
	}

	if (filler.place === "typed" || filler.place === "pi") {
		const key = yield* valueOf(filler, typed);

		yield* saveKey(filler.vendor, key);
	}

	const keyFile = yield* keyFileOf(filler.vendor);

	return { keyFile } satisfies KeySource;
});

const savedKey = Effect.fnUntraced(function* savedKey(filler: Signed, typed: Typed) {
	if (filler.kind !== "key") {
		return filler;
	}

	const source = yield* sourceOf(filler, typed);

	return { kind: "source", label: keyNamed(filler), source, vendor: filler.vendor } satisfies Filler;
});

export { checkedKeys, savedKey };

export type { Typed };
