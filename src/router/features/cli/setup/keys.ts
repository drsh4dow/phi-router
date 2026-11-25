import { Effect, Option, Schema, pipe } from "effect";
import { CliError } from "effect/cli";
import { KeyChecks } from "#router/client/keys/index.ts";
import type { Redacted } from "effect";
import type { Vendor } from "#router/client/configuration/index.ts";
import { tokenKindOf } from "#router/features/cli/accounts/index.ts";
import { vendorNames } from "./copy.ts";

class SetupStopped extends Schema.TaggedError<SetupStopped, { readonly brand: unique symbol }>()("SetupStopped", {
	copy: Schema.String,
}) {
	public override get [CliError.userMessage](): string {
		return this.copy;
	}
}

const stopped = (copy: string): SetupStopped => SetupStopped.make({ copy });

const keyPrefixes = { anthropic: "sk-ant-api", openai: "sk-" } as const;

interface KeyAsk {
	readonly vendor: Vendor;
	readonly harnessTitle: string;
}

const misfitOf = ({ ask, key }: { readonly ask: KeyAsk; readonly key: string }): Option.Option<string> =>
	pipe(
		tokenKindOf(key),
		Option.flatMap(({ scheme, vendor }) => {
			if (vendor !== ask.vendor) {
				return Option.some(
					`That is an ${vendorNames[vendor]} key. ${ask.harnessTitle} needs an ${vendorNames[ask.vendor]} key, which starts with ${keyPrefixes[ask.vendor]}. Nothing was saved.`,
				);
			}

			if (scheme === "oauth") {
				return Option.some(
					`That is a Claude subscription token, not an API key. Setup needs the API key your organization gave you for patient data. Nothing was saved. Paste a key that starts with ${keyPrefixes[ask.vendor]}.`,
				);
			}

			return Option.none();
		}),
	);

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

	return Option.some(unaccepted[answer](vendorNames[vendor]));
});

export { misfitOf, refusalOf, stopped };
