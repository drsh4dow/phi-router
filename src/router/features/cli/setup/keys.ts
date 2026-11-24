import { Array, Console, Effect, Option, Redacted, Schema, String as Str, pipe } from "effect";
import { KeyChecks, keyFileOf, saveKey, savedKey } from "#router/client/keys/index.ts";
import { hiddenLine, typedLine } from "#router/client/terminal.ts";
import { CliError } from "effect/cli";
import type { Vendor } from "#router/client/configuration/index.ts";
import { storedAnthropicKey } from "#router/client/harnesses/index.ts";
import { tokenKinds } from "#router/features/cli/accounts/index.ts";

/** Setup stopped, and changed only what `copy` says. `copy` is the whole of what the human reads, and holds no key. */
class SetupStopped extends Schema.TaggedError<SetupStopped, { readonly brand: unique symbol }>()("SetupStopped", {
	copy: Schema.String,
}) {
	public override get [CliError.userMessage](): string {
		return this.copy;
	}
}

const stopped = (copy: string): SetupStopped => SetupStopped.make({ copy });

const vendorWords = {
	anthropic: { name: "Anthropic", prefix: "sk-ant-api" },
	openai: { name: "OpenAI", prefix: "sk-" },
} as const;

/** One key setup needs: its vendor, who needs it, as a refusal names them, and the lines that ask for it. */
interface KeyAsk {
	readonly vendor: Vendor;
	readonly needer: string;
	readonly question: readonly string[];
}

interface HeldKey {
	readonly vendor: Vendor;
	readonly key: Readonly<Redacted.Redacted>;
}

const baaAsk = (asked: { readonly vendor: Vendor; readonly needer: string }): KeyAsk => ({
	needer: asked.needer,
	question: [
		`Paste the ${vendorWords[asked.vendor].name} API key your organization gave you for patient data.`,
		`It starts with ${vendorWords[asked.vendor].prefix}. Nothing shows while you paste. Then press Enter.`,
		"The key is saved only on this computer, in a file only you can read.",
	],
	vendor: asked.vendor,
});

/**
 * What a key's prefix says it is. None when no known prefix fits.
 *
 * @param {string} key The key.
 * @returns {Option.Option<object>} Its vendor and scheme.
 */
const kindOf = (key: string): Option.Option<{ readonly scheme: "apiKey" | "oauth"; readonly vendor: Vendor }> =>
	pipe(
		tokenKinds,
		Array.findFirst(([prefix]) => Str.startsWith(prefix)(key)),
		Option.flatMap(([, known]) => known),
	);

/**
 * Why a pasted key cannot be what `ask` asks for, by its prefix: a key of the other vendor, or a Claude subscription
 * token. None when its prefix fits, or says nothing, so the vendor decides.
 *
 * @param {KeyAsk} ask The question.
 * @param {string} key The pasted key.
 * @returns {Option.Option<string>} The copy that refuses it.
 */
const misfitOf = (ask: KeyAsk, key: string): Option.Option<string> => {
	const wanted = vendorWords[ask.vendor];

	return pipe(
		kindOf(key),
		Option.flatMap(({ scheme, vendor }) => {
			if (vendor !== ask.vendor) {
				return Option.some(
					`That is an ${vendorWords[vendor].name} key. ${ask.needer} needs an ${wanted.name} key, which starts with ${wanted.prefix}. Nothing was saved.`,
				);
			}

			if (scheme === "oauth") {
				return Option.some(
					`That is a Claude subscription token, not an API key. Setup needs the API key your organization gave you for patient data. Nothing was saved. Paste a key that starts with ${wanted.prefix}.`,
				);
			}

			return Option.none();
		}),
	);
};

const unaccepted = {
	refused: (name: string) =>
		`${name} refused that key. Nothing was saved or changed. Check it with whoever gave it to you, then rerun the command.`,
	unanswered: (name: string) =>
		`Setup could not reach ${name} to check that key. Nothing was saved or changed. Check your connection, then rerun the command.`,
} as const;

const endedEarly = stopped("Setup ended before it got a key. Nothing was saved or changed.");

/** Asks the vendor about `key`. None when it accepts it, else the copy that says it did not. */
const refusalOf = Effect.fnUntraced(function* refusalOf(vendor: Vendor, key: Readonly<Redacted.Redacted>) {
	const checks = yield* KeyChecks;
	const answer = yield* checks.check(vendor, key);

	if (answer === "accepted") {
		return Option.none<string>();
	}

	return Option.some(unaccepted[answer](vendorWords[vendor].name));
});

/** Asks the vendor about `key`, and stops setup unless it accepts it. */
const accepted = Effect.fnUntraced(function* accepted(vendor: Vendor, key: Readonly<Redacted.Redacted>) {
	const refusal = yield* refusalOf(vendor, key);

	if (Option.isSome(refusal)) {
		return yield* stopped(refusal.value);
	}

	return { key, vendor } satisfies HeldKey;
});

/** Asks `ask`'s question, reads the key hidden, and keeps it once its prefix fits and its vendor accepts it. */
const pasted = Effect.fnUntraced(function* pasted(ask: KeyAsk) {
	yield* Console.log(Array.join(ask.question, "\n"));

	const line = yield* Effect.flatMap(hiddenLine("Key: "), (read) =>
		Effect.mapError(Effect.fromOption(read), () => endedEarly),
	);

	const key = Str.trim(Redacted.value(line));
	const misfit = misfitOf(ask, key);

	if (Option.isSome(misfit)) {
		return yield* stopped(misfit.value);
	}

	yield* Console.log("");

	return yield* accepted(ask.vendor, Redacted.make(key));
});

const yesAnswers: ReadonlySet<string> = new Set(["y", "yes"]);

/** Whether the human answers yes to `question`. Anything else, Enter and the input's end included, is No. */
const saidYes = Effect.fnUntraced(function* saidYes(question: string) {
	const answer = yield* typedLine(question);

	yield* Console.log("");

	return Option.exists(answer, (said) => yesAnswers.has(Str.toLowerCase(Str.trim(said))));
});

const piOffer = "pi already has an Anthropic API key. Use it? Say yes only if it is from your BAA account. [y/N] ";

/**
 * The Anthropic API key pi stored, once the human says yes to it. None when `ask` is for another vendor, pi prints
 * anything but an Anthropic API key, such as a subscription token, or the human says anything but yes. No part of the
 * key shows.
 */
const takenFromPi = Effect.fnUntraced(function* takenFromPi(ask: KeyAsk) {
	if (ask.vendor !== "anthropic") {
		return Option.none<Redacted.Redacted>();
	}

	const stored = yield* storedAnthropicKey();

	const offered = pipe(
		stored,
		Option.filter((key) =>
			Option.exists(
				kindOf(Redacted.value(key)),
				({ scheme, vendor }) => scheme === "apiKey" && vendor === ask.vendor,
			),
		),
	);

	if (Option.isNone(offered)) {
		return offered;
	}

	const yes = yield* saidYes(piOffer);

	return pipe(
		offered,
		Option.filter(() => yes),
	);
});

/**
 * The Anthropic API key pi stored, once the human takes it and Anthropic accepts it. None, so setup asks for a paste,
 * otherwise. When Anthropic does not accept it, setup says so first.
 */
const fromPi = Effect.fnUntraced(function* fromPi(ask: KeyAsk) {
	const taken = yield* takenFromPi(ask);

	if (Option.isNone(taken)) {
		return Option.none<HeldKey>();
	}

	const refusal = yield* refusalOf(ask.vendor, taken.value);

	if (Option.isSome(refusal)) {
		yield* Console.log(`${refusal.value}\n`);

		return Option.none<HeldKey>();
	}

	return Option.some({ key: taken.value, vendor: ask.vendor } satisfies HeldKey);
});

/** The key the human gives for `ask`: the one pi stored, when they take it, else a pasted one. */
const keyFor = Effect.fnUntraced(function* keyFor(ask: KeyAsk) {
	const taken = yield* fromPi(ask);

	return yield* Option.match(taken, { onNone: () => pasted(ask), onSome: Effect.succeed });
});

/** The key saved for `vendor` when its vendor still accepts it. None when there is none, or `fresh` asks for a new one. */
const stillHeld = Effect.fnUntraced(function* stillHeld(vendor: Vendor, fresh: boolean) {
	const saved = yield* savedKey(vendor);

	const kept = pipe(
		saved,
		Option.filter(() => !fresh),
	);

	if (Option.isNone(kept)) {
		return Option.none<HeldKey>();
	}

	const checks = yield* KeyChecks;
	const answer = yield* checks.check(vendor, kept.value);

	return Option.liftPredicate({ key: kept.value, vendor } satisfies HeldKey, () => answer === "accepted");
});

/** Saves the key in its vendor's key file, and gives the file. */
const savedKeyFile = Effect.fnUntraced(function* savedKeyFile({ key, vendor }: HeldKey) {
	yield* saveKey(vendor, key);

	return yield* keyFileOf(vendor);
});

export { baaAsk, keyFor, savedKeyFile, stillHeld, stopped, vendorWords };

export type { HeldKey };
