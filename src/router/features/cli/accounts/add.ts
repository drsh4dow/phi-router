import { Array, Console, DateTime, Effect, Option, Predicate, Redacted, Schema, String as Str, pipe } from "effect";
import type { Lane, Vendor } from "#router/client/configuration/index.ts";
import { loginFolders, loginIn, readKey } from "#router/client/accounts/index.ts";
import { CliError } from "effect/cli";
import type { NewAccount } from "#router/client/config-writer.ts";
import { addAccounts } from "#router/client/config-writer.ts";
import { realFolder } from "#router/client/processes.ts";

interface AddRequest {
	readonly loginFolder: string | undefined;
	readonly keyCommand: string | undefined;
	readonly sealed: boolean;
}

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

const laneOf = (sealed: boolean): Lane => {
	if (sealed) {
		return "sealed";
	}

	return "clean";
};

const foundBy = Effect.fnUntraced(function* foundBy(request: AddRequest) {
	const { keyCommand, loginFolder } = request;

	if (Predicate.isNotUndefined(loginFolder) && Predicate.isNotUndefined(keyCommand)) {
		return yield* refused("Name a login folder or --command, not both.");
	}

	if (Predicate.isNotUndefined(loginFolder)) {
		return yield* Effect.flatMap(realFolder(loginFolder), fromFolder);
	}

	if (Predicate.isNotUndefined(keyCommand)) {
		return yield* fromCommand(keyCommand);
	}

	return yield* refused('Name a login folder, or --command "<prints the token>".');
});

const accountsAdd = Effect.fn("accountsAdd")(function* accountsAdd(request: AddRequest) {
	const lane = laneOf(request.sealed);
	const found = yield* foundBy(request);

	const [placed] = yield* addAccounts({ accounts: [{ account: found.account, lane }] }).pipe(
		Effect.catchTags({
			PlatformError: (error) => Effect.fail(refused(`config.json could not be read or written. ${error.message}`)),
			SchemaError: (error) =>
				Effect.fail(refused(`The router could not serve config.json with this account. ${error.message}.`)),
		}),
	);

	if (!placed.isNew) {
		return yield* Console.log(`${placed.name} is already on the ${placed.lane} lane. Nothing changed.`);
	}

	const where = Option.match(placed.vendorAccountBefore, {
		onNone: () => `the first ${found.vendorName} account there`,
		onSome: (before) => `after ${before}`,
	});

	return yield* Console.log(
		`Added ${placed.name} to the ${lane} lane, ${where}.\n  ${found.summary}\nA running router serves it from its next request.`,
	);
}, DateTime.withCurrentZoneLocal);

export { accountsAdd, tokenKindOf };
