import { Effect, Option, Schema, pipe } from "effect";
import { CliError } from "effect/cli";
import { KeyChecks } from "#router/client/keys/index.ts";
import type { Redacted } from "effect";
import type { Vendor } from "#router/client/configuration/index.ts";
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
}

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

const refusalOf = Effect.fnUntraced(function* refusalOf(vendor: Vendor, key: Readonly<Redacted.Redacted>) {
	const checks = yield* KeyChecks;
	const answer = yield* checks.check(vendor, key);

	if (answer === "accepted") {
		return Option.none<string>();
	}

	return Option.some(unaccepted[answer](vendorWords[vendor].name));
});

export { misfitOf, refusalOf, stopped };
