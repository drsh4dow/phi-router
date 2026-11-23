import { Array, Console, DateTime, Effect, Option, Predicate, Redacted, Schema, String as Str, pipe } from "effect";
import type { Lane, Vendor } from "#router/client/lane-configuration.ts";
import { loginFolders, loginIn } from "#router/client/login-folders.ts";
import { CliError } from "effect/cli";
import type { NewAccount } from "#router/client/config-writer.ts";
import { addAccounts } from "#router/client/config-writer.ts";
import { readKey } from "#router/client/credentials.ts";
import { realFolder } from "#router/client/processes.ts";

/** What `accounts add` was asked: a login folder or a command that prints a token, and whether the lane is sealed. */
interface AddRequest {
	readonly folder: string | undefined;
	readonly command: string | undefined;
	readonly sealed: boolean;
}

/** `accounts add` changed nothing. The reason never holds a token. */
class AddRefused extends Schema.TaggedError<AddRefused, { readonly brand: unique symbol }>()("AddRefused", {
	reason: Schema.String,
}) {
	public override get [CliError.userMessage](): string {
		return `phi-router: ${this.reason} Nothing changed.`;
	}
}

/** An account found, the vendor's word for it, and the line that tells the human what it is. */
interface Found {
	readonly account: NewAccount;
	readonly label: "Claude" | "Codex" | "OpenAI";
	readonly told: string;
}

/** What a token is, and the words that tell the human after its length. */
interface TokenKind {
	readonly vendor: Vendor;
	readonly scheme: "apiKey" | "oauth";
	readonly label: "Claude" | "OpenAI";
	readonly noun: "token" | "key";
	readonly lasts: string;
}

/** What a token's prefix says it is, the first prefix that matches. An `sk-ant-` token of no known kind is no OpenAI key. */
const tokenKinds: readonly (readonly [string, Option.Option<TokenKind>])[] = [
	[
		"sk-ant-oat",
		Option.some({
			label: "Claude",
			lasts: " Lasts 1 year. Needs no refresh.",
			noun: "token",
			scheme: "oauth",
			vendor: "anthropic",
		}),
	],
	["sk-ant-api", Option.some({ label: "Claude", lasts: "", noun: "key", scheme: "apiKey", vendor: "anthropic" })],
	["sk-ant-", Option.none()],
	["sk-", Option.some({ label: "OpenAI", lasts: "", noun: "key", scheme: "apiKey", vendor: "openai" })],
];

const refused = (reason: string): AddRefused => AddRefused.make({ reason });

/** A login folder's vendor by its credential file. It runs no vendor CLI and reads no token. */
const fromFolder = Effect.fnUntraced(function* fromFolder(folder: string) {
	const seen = yield* loginIn(folder);

	if (Option.isNone(seen)) {
		return yield* refused(
			`${folder} holds no login: no .credentials.json with claudeAiOauth and no auth.json with tokens. Log in there first with ${loginFolders.anthropic.fix(folder)}, or ${loginFolders.openai.fix(folder)}.`,
		);
	}

	const { ends, vendor } = seen.value;

	if (vendor === "openai") {
		const told = "Codex home folder. codex refreshes it.";

		return { account: { loginFolder: folder, vendor }, label: "Codex", told } satisfies Found;
	}

	const day = yield* Effect.transposeOption(pipe(ends, Option.map(DateTime.setZoneCurrent)));

	const ending = pipe(
		day,
		Option.match({ onNone: () => "", onSome: (end) => ` Its login ends ${DateTime.formatIsoDate(end)}.` }),
	);

	return {
		account: { loginFolder: folder, vendor },
		label: "Claude",
		told: `Claude login folder.${ending} claude refreshes it.`,
	} satisfies Found;
});

/** A token command's vendor and scheme by the prefix of what it prints, run once. Only the token's length is kept. */
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

	const kind = pipe(
		tokenKinds,
		Array.findFirst(([prefix]) => Str.startsWith(prefix)(value)),
		Option.flatMap(([, known]) => known),
	);

	if (Option.isNone(kind)) {
		return yield* refused("The command printed a token whose prefix is unknown. Known: sk-ant-oat, sk-ant-api, sk-.");
	}

	const { label, lasts, noun, scheme, vendor } = kind.value;
	const told = `${label} ${noun}, ${String(value.length)} characters.${lasts}`;

	return { account: { keyCommand: command, scheme, vendor }, label, told } satisfies Found;
});

const laneOf = (sealed: boolean): Lane => {
	if (sealed) {
		return "sealed";
	}

	return "clean";
};

const foundBy = Effect.fnUntraced(function* foundBy(request: AddRequest) {
	const { command, folder } = request;

	if (Predicate.isNotUndefined(folder) && Predicate.isNotUndefined(command)) {
		return yield* refused("Name a login folder or --command, not both.");
	}

	if (Predicate.isNotUndefined(folder)) {
		return yield* Effect.flatMap(realFolder(folder), fromFolder);
	}

	if (Predicate.isNotUndefined(command)) {
		return yield* fromCommand(command);
	}

	return yield* refused('Name a login folder, or --command "<prints the token>".');
});

/**
 * Adds one account to the clean lane, or the sealed lane with `sealed`: a login folder a vendor CLI logged in to, or a
 * command that prints a token. It names the account after its vendor, prints what it added, and stores the folder or
 * the command, never the token.
 */
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

	if (!placed.added) {
		return yield* Console.log(`${placed.name} is already on the ${placed.lane} lane. Nothing changed.`);
	}

	const where = Option.match(placed.after, {
		onNone: () => `the first ${found.label} account there`,
		onSome: (before) => `after ${before}`,
	});

	return yield* Console.log(
		`Added ${placed.name} to the ${lane} lane, ${where}.\n  ${found.told}\nA running router serves it from its next request.`,
	);
}, DateTime.withCurrentZoneLocal);

export { accountsAdd };
