import { Array, DateTime, Effect, Option, Predicate, Redacted, Schema, String as Str, pipe } from "effect";
import { loginFolders, loginIn, readKey } from "#router/client/accounts/index.ts";
import { CliError } from "effect/cli";
import type { NewAccount } from "#router/client/config-writer.ts";
import type { Vendor } from "#router/client/configuration/index.ts";

class AddRefused extends Schema.TaggedError<AddRefused, { readonly brand: unique symbol }>()("AddRefused", {
	reason: Schema.String,
}) {
	public override get [CliError.userMessage](): string {
		return `phi-router: ${this.reason} Nothing changed.`;
	}
}

interface Found {
	readonly account: NewAccount;
	readonly vendorName: "Claude" | "Codex" | "OpenAI";
	readonly summary: string;
}

interface TokenKind {
	readonly vendor: Vendor;
	readonly scheme: "apiKey" | "oauth";
	readonly vendorName: "Claude" | "OpenAI";
	readonly noun: "token" | "key";
	readonly lifetimeNote: string;
}

const tokenKinds: readonly (readonly [string, Option.Option<TokenKind>])[] = [
	[
		"sk-ant-oat",
		Option.some({
			lifetimeNote: " Lasts 1 year. Needs no refresh.",
			noun: "token",
			scheme: "oauth",
			vendor: "anthropic",
			vendorName: "Claude",
		}),
	],
	[
		"sk-ant-api",
		Option.some({ lifetimeNote: "", noun: "key", scheme: "apiKey", vendor: "anthropic", vendorName: "Claude" }),
	],
	["sk-ant-", Option.none()],
	["sk-", Option.some({ lifetimeNote: "", noun: "key", scheme: "apiKey", vendor: "openai", vendorName: "OpenAI" })],
];

const tokenKindOf = (token: string): Option.Option<TokenKind> =>
	pipe(
		tokenKinds,
		Array.findFirst(([prefix]) => Str.startsWith(prefix)(token)),
		Option.flatMap(([, known]) => known),
	);

const refused = (reason: string): AddRefused => AddRefused.make({ reason });

const fromFolder = Effect.fnUntraced(function* fromFolder(folder: string) {
	const seen = yield* loginIn(folder);

	if (Option.isNone(seen)) {
		return yield* refused(
			`${folder} holds no login: no .credentials.json with claudeAiOauth and no auth.json with tokens. Log in there first with ${loginFolders.anthropic.loginCommand(folder)}, or ${loginFolders.openai.loginCommand(folder)}.`,
		);
	}

	const { ends, vendor } = seen.value;

	if (vendor === "openai") {
		const summary = "Codex home folder. codex refreshes it.";

		return { account: { loginFolder: folder, vendor }, summary, vendorName: "Codex" } satisfies Found;
	}

	const day = yield* Effect.transposeOption(pipe(ends, Option.map(DateTime.setZoneCurrent)));

	const ending = pipe(
		day,
		Option.match({ onNone: () => "", onSome: (end) => ` Its login ends ${DateTime.formatIsoDate(end)}.` }),
	);

	return {
		account: { loginFolder: folder, vendor },
		summary: `Claude login folder.${ending} claude refreshes it.`,
		vendorName: "Claude",
	} satisfies Found;
});

const fromCommand = Effect.fnUntraced(function* fromCommand(command: string) {
	const token = yield* Effect.mapError(readKey({ keyCommand: command }), (error) =>
		refused(
			pipe(
				Option.liftPredicate(error.cause, Predicate.isString),
				Option.match({ onNone: () => `${error.message}.`, onSome: (cause) => `${error.message}: ${cause}.` }),
			),
		),
	);

	const value = Redacted.value(token);

	const kind = tokenKindOf(value);

	if (Option.isNone(kind)) {
		return yield* refused("The command printed a token whose prefix is unknown. Known: sk-ant-oat, sk-ant-api, sk-.");
	}

	const { lifetimeNote, noun, scheme, vendor, vendorName } = kind.value;
	const summary = `${vendorName} ${noun}, ${String(value.length)} characters.${lifetimeNote}`;

	return { account: { keyCommand: command, scheme, vendor }, summary, vendorName } satisfies Found;
});

export { fromCommand, fromFolder, refused, tokenKindOf };
