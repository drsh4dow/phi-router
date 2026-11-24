import { Array, Console, Effect, Option, Redacted, Schema, String as Str, pipe } from "effect";
import { KeyChecks, keyFileOf, saveKey, savedKey } from "#router/client/keys/index.ts";
import { hiddenLine, typedLine } from "#router/client/terminal.ts";
import { CliError } from "effect/cli";
import type { Vendor } from "#router/client/configuration/index.ts";
import { storedAnthropicKey } from "#router/client/harnesses/index.ts";
import { tokenKindOf } from "#router/features/cli/accounts/index.ts";

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

interface KeyAsk {
	readonly vendor: Vendor;
	readonly harnessTitle: string;
	readonly questionLines: readonly string[];
}

interface HeldKey {
	readonly vendor: Vendor;
	readonly key: Readonly<Redacted.Redacted>;
}

const baaAsk = (asked: { readonly vendor: Vendor; readonly harnessTitle: string }): KeyAsk => ({
	harnessTitle: asked.harnessTitle,
	questionLines: [
		`Paste the ${vendorWords[asked.vendor].name} API key your organization gave you for patient data.`,
		`It starts with ${vendorWords[asked.vendor].prefix}. Nothing shows while you paste. Then press Enter.`,
		"The key is saved only on this computer, in a file only you can read.",
	],
	vendor: asked.vendor,
});

const misfitOf = ({ ask, key }: { readonly ask: KeyAsk; readonly key: string }): Option.Option<string> => {
	const wanted = vendorWords[ask.vendor];

	return pipe(
		tokenKindOf(key),
		Option.flatMap(({ scheme, vendor }) => {
			if (vendor !== ask.vendor) {
				return Option.some(
					`That is an ${vendorWords[vendor].name} key. ${ask.harnessTitle} needs an ${wanted.name} key, which starts with ${wanted.prefix}. Nothing was saved.`,
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

const refusalOf = Effect.fnUntraced(function* refusalOf(vendor: Vendor, key: Readonly<Redacted.Redacted>) {
	const checks = yield* KeyChecks;
	const answer = yield* checks.check(vendor, key);

	if (answer === "accepted") {
		return Option.none<string>();
	}

	return Option.some(unaccepted[answer](vendorWords[vendor].name));
});

const accepted = Effect.fnUntraced(function* accepted(vendor: Vendor, key: Readonly<Redacted.Redacted>) {
	const refusal = yield* refusalOf(vendor, key);

	if (Option.isSome(refusal)) {
		return yield* stopped(refusal.value);
	}

	return { key, vendor } satisfies HeldKey;
});

const pasted = Effect.fnUntraced(function* pasted(ask: KeyAsk) {
	yield* Console.log(Array.join(ask.questionLines, "\n"));

	const line = yield* Effect.flatMap(hiddenLine("Key: "), (read) =>
		Effect.mapError(Effect.fromOption(read), () => endedEarly),
	);

	const key = Str.trim(Redacted.value(line));
	const misfit = misfitOf({ ask, key });

	if (Option.isSome(misfit)) {
		return yield* stopped(misfit.value);
	}

	yield* Console.log("");

	return yield* accepted(ask.vendor, Redacted.make(key));
});

const yesAnswers: ReadonlySet<string> = new Set(["y", "yes"]);

const isYes = Option.exists<string>((said) => yesAnswers.has(Str.toLowerCase(Str.trim(said))));

const saidYes = Effect.fnUntraced(function* saidYes(question: string) {
	const answer = yield* typedLine(question);

	yield* Console.log("");

	return isYes(answer);
});

const piOffer = "pi already has an Anthropic API key. Use it? Say yes only if it is from your BAA account. [y/N] ";

const takenFromPi = Effect.fnUntraced(function* takenFromPi(ask: KeyAsk) {
	if (ask.vendor !== "anthropic") {
		return Option.none<Redacted.Redacted>();
	}

	const stored = yield* storedAnthropicKey();

	const offered = pipe(
		stored,
		Option.filter((key) =>
			Option.exists(
				tokenKindOf(Redacted.value(key)),
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

const keyFor = Effect.fnUntraced(function* keyFor(ask: KeyAsk) {
	const taken = yield* fromPi(ask);

	return yield* Option.match(taken, { onNone: () => pasted(ask), onSome: Effect.succeed });
});

const stillHeld = Effect.fnUntraced(function* stillHeld(vendor: Vendor, fresh: boolean) {
	const saved = yield* savedKey(vendor);

	const kept = pipe(
		saved,
		Option.filter(() => !fresh),
	);

	if (Option.isNone(kept)) {
		return Option.none<HeldKey>();
	}

	const refusal = yield* refusalOf(vendor, kept.value);

	return Option.liftPredicate({ key: kept.value, vendor } satisfies HeldKey, () => Option.isNone(refusal));
});

const savedKeyFile = Effect.fnUntraced(function* savedKeyFile({ key, vendor }: HeldKey) {
	yield* saveKey(vendor, key);

	return yield* keyFileOf(vendor);
});

export { baaAsk, isYes, keyFor, misfitOf, refusalOf, savedKeyFile, stillHeld, stopped, vendorWords };

export type { HeldKey };
