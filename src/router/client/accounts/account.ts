import type { Array, Effect, Scope, Stream } from "effect";
import type { LoginEnded } from "./login-folders.ts";
import type { Refused } from "./refused.ts";
import type { Rejected } from "./rejected.ts";

type Headers = Readonly<Record<string, string | undefined>>;

/** An account's answer once its status is known, before any byte of its body is read. A 429 or a 5xx is an answer. */
interface Answered {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Stream.Stream<Uint8Array, Refused>;
}

/** Why an account gave no answer the route can relay or fail over on. */
type Unanswered = Refused | LoginEnded | Rejected;

/** One account the router calls. Its credential stays in `upstream.ts`. */
interface Account {
	readonly name: string;
	/** The models a BAA account does not carry. Empty on an open account, since the clean lane runs every model. */
	readonly lacks: readonly string[];
	/**
	 * Makes the account's credential fit to send before the send reads the verdict store: a login folder's vendor CLI
	 * runs here when its token needs a refresh, and never inside `send`. Nothing for any other account.
	 */
	readonly ready: () => Effect.Effect<void, LoginEnded>;
	readonly send: (request: {
		readonly headers: Headers;
		readonly body: string;
	}) => Effect.Effect<Answered, Unanswered, Scope.Scope>;
}

/**
 * The accounts behind one vendor's lanes, each lane in the file's order, with the model `phi/auto` stands for there and
 * the substitute a BAA account runs in place of a target model it lacks.
 */
interface Accounts {
	readonly clean: Array.NonEmptyReadonlyArray<Account>;
	readonly sealed: Array.NonEmptyReadonlyArray<Account>;
	readonly targetModel: string;
	readonly sealedModel: string;
}

/** OpenAI's accounts, and the first open account's model catalog. A BAA account is never asked for one. */
interface OpenAiAccounts extends Accounts {
	readonly catalog: (request: {
		readonly headers: Headers;
		readonly query: Headers;
	}) => Effect.Effect<Answered, Unanswered, Scope.Scope>;
}

export type { Account, Accounts, Answered, Headers, OpenAiAccounts, Unanswered };
