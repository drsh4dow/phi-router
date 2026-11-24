import type { AccountState, Accounts } from "#router/client/accounts/index.ts";
import { Effect, Option, Record, Schema, Struct } from "effect";
import type { Harness, Target } from "#router/features/border/index.ts";
import { cleanLaneKeys, decodeRequest as decodeResponsesRequest } from "#router/features/codex/index.ts";
import { decodeRequest, replyKeys } from "#router/features/anthropic-messages/index.ts";
import type { Digest } from "effect/crypto";
import type { Message } from "#router/features/parts/index.ts";
import type { Routing } from "./routing.ts";
import { piWire } from "#shared/pi.ts";

interface CleanLaneRefused {
	readonly _tag: "CleanLaneRefused";
}

interface Decoded {
	readonly model: string;
	readonly messages: readonly Message[];
	readonly encode: (target: Target) => Effect.Effect<string, CleanLaneRefused>;
	readonly withoutReasoning?: (target: Target) => Effect.Effect<string, CleanLaneRefused>;
	readonly title?: boolean;
}

class Unreadable extends Schema.TaggedError<Unreadable, { readonly brand: unique symbol }>()("Unreadable", {
	reason: Schema.String,
}) {}

interface HarnessWire {
	readonly harness: Harness;
	readonly sessionHeader: string;
	readonly decode: (
		body: string,
		openWrote: (key: string) => boolean,
	) => Effect.Effect<Decoded, Unreadable, Digest.Digest>;
	readonly replyKeys: (reply: string) => Effect.Effect<readonly string[], { readonly message: string }, Digest.Digest>;
	readonly vendorErrorBody: (status: number, message: string) => Effect.Effect<string>;
}

interface Serving extends Routing {
	readonly wire: HarnessWire;
	readonly accounts: Accounts;
	readonly accountState: AccountState["Service"];
}

const badRequest = 400;

const errorType = (status: number, otherwise: string): string => {
	if (status === badRequest) {
		return "invalid_request_error";
	}

	return otherwise;
};

const AnthropicError = Schema.fromJsonString(
	Schema.Struct({
		error: Schema.Struct({ message: Schema.String, type: Schema.String }),
		type: Schema.Literal("error"),
	}),
);

const anthropicErrorBody = (status: number, message: string): Effect.Effect<string> =>
	Effect.orDie(
		Schema.encodeEffect(AnthropicError)({
			error: { message, type: errorType(status, "api_error") },
			type: "error",
		}),
	);

const piModelNames: Readonly<Record<string, string>> = piWire.models;

const piMessages = `${piWire.base}/v1/messages` as const;

const OpenAiError = Schema.fromJsonString(
	Schema.Struct({ error: Schema.Struct({ message: Schema.String, type: Schema.String }) }),
);

type Wires = { readonly [Name in Harness]: HarnessWire & { readonly harness: Name } };

const wires: Wires = {
	claude: {
		decode: (body, openWrote) =>
			Effect.mapError(decodeRequest(body, openWrote, "claude"), ({ reason }) => Unreadable.make({ reason })),
		harness: "claude",
		replyKeys,
		sessionHeader: "x-claude-code-session-id",
		vendorErrorBody: anthropicErrorBody,
	},
	codex: {
		decode: (body, openWrote) =>
			Effect.mapError(decodeResponsesRequest(body, openWrote), ({ reason }) => Unreadable.make({ reason })),
		harness: "codex",
		replyKeys: cleanLaneKeys,
		sessionHeader: "session-id",
		vendorErrorBody: (status, message) =>
			Effect.orDie(
				Schema.encodeEffect(OpenAiError)({ error: { message, type: errorType(status, "server_error") } }),
			),
	},
	pi: {
		decode: (body, openWrote) =>
			Effect.mapBoth(decodeRequest(body, openWrote, "pi"), {
				onFailure: ({ reason }) => Unreadable.make({ reason }),
				onSuccess: (decoded) =>
					Struct.assign(decoded, {
						model: Option.getOrElse(Record.get(piModelNames, decoded.model), () => decoded.model),
					}),
			}),
		harness: "pi",
		replyKeys,
		sessionHeader: piWire.sessionHeader,
		vendorErrorBody: anthropicErrorBody,
	},
};

export { piMessages, wires };

export type { Decoded, HarnessWire, Serving };
