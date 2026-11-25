import { Array, Config, Effect, Option, Record, pipe } from "effect";
import type { HarnessName, Target } from "./harnesses.ts";
import { keyInTerminal, keyInputs, pasteAsked } from "./copy.ts";
import type { Ready } from "./plan.ts";
import type { Vendor } from "#router/client/configuration/index.ts";
import { installedIn } from "./install.ts";
import { isTerminal } from "#router/client/terminal.ts";
import { pastedKey } from "#router/client/keys/index.ts";
import { stopped } from "./keys.ts";
import { typedKey } from "./asked.ts";

const givenKey = Effect.fnUntraced(function* givenKey(name: HarnessName, vendor: Vendor, roles: Ready["roles"]) {
	const given = yield* Config.option(Config.Redacted(keyInputs[vendor]));

	if (Option.isSome(given)) {
		return given;
	}

	const terminal = yield* isTerminal;

	if (terminal) {
		const [, typed] = yield* typedKey(vendor, roles);

		return Option.some(typed);
	}

	if (name === "claude") {
		return yield* pastedKey(vendor);
	}

	return Option.none();
});

interface Given {
	readonly answersJson: string | undefined;
	readonly target: Target;
}

const keysAsked = Effect.fnUntraced(function* keysAsked(
	name: HarnessName,
	missing: Array.NonEmptyReadonlyArray<Vendor>,
	given: Given,
) {
	if (name === "codex") {
		return yield* stopped(keyInTerminal(given.answersJson));
	}

	if (name !== "claude") {
		return yield* stopped(`Setup needs the key in ${keyInputs[Array.headNonEmpty(missing)]}. Nothing changed.`);
	}

	yield* installedIn(name, given.target);

	return yield* stopped(pasteAsked(missing));
});

const givenKeys = Effect.fnUntraced(function* givenKeys(name: HarnessName, ready: Ready, given: Given) {
	const held = yield* Effect.forEach(
		ready.typed,
		(vendor) =>
			Effect.map(
				givenKey(name, vendor, ready.roles),
				Option.map((key) => [vendor, key] as const),
			),
		{ concurrency: 1 },
	);

	const typed = Array.getSomes(held);

	const missing = Array.difference(
		ready.typed,
		pipe(
			typed,
			Array.map(([vendor]) => vendor),
		),
	);

	if (Array.isReadonlyArrayNonEmpty(missing)) {
		return yield* keysAsked(name, missing, given);
	}

	return Record.fromEntries(typed);
});

export { givenKeys };
