import type { Array, Effect, Scope, Stream } from "effect";
import type { LoginEnded } from "./login-folders.ts";
import type { NoAnswer } from "./no-answer.ts";
import type { Rejected } from "./rejected.ts";

type Headers = Readonly<Record<string, string | undefined>>;

interface Answered {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Stream.Stream<Uint8Array, NoAnswer>;
}

type Unanswered = NoAnswer | LoginEnded | Rejected;

interface Account {
	readonly name: string;
	readonly lacks: readonly string[];
	readonly ready: () => Effect.Effect<void, LoginEnded>;
	readonly send: (request: {
		readonly headers: Headers;
		readonly body: string;
	}) => Effect.Effect<Answered, Unanswered, Scope.Scope>;
}

interface Accounts {
	readonly clean: Array.NonEmptyReadonlyArray<Account>;
	readonly sealed: Array.NonEmptyReadonlyArray<Account>;
	readonly targetModel: string;
	readonly sealedModel: string;
}

interface OpenAiAccounts extends Accounts {
	readonly catalog: (request: {
		readonly headers: Headers;
		readonly query: Headers;
	}) => Effect.Effect<Answered, Unanswered, Scope.Scope>;
}

export type { Account, Accounts, Answered, Headers, OpenAiAccounts, Unanswered };
