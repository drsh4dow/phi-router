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
	/** The body for one lane. The clean lane takes what the border returned for `messages`, same length and order. */
	readonly encode: (target: Target) => Effect.Effect<string, CleanLaneRefused>;
	/** `encode` with every reasoning item dropped from the clean body, for an account that could not read one. Codex alone has it. */
	readonly withoutReasoning?: (target: Target) => Effect.Effect<string, CleanLaneRefused>;
	readonly title?: boolean;
}

/** The body is not one the harness's codec names. `reason` names the field, never its value. */
class Unreadable extends Schema.TaggedError<Unreadable, { readonly brand: unique symbol }>()("Unreadable", {
	reason: Schema.String,
}) {}

/**
 * How one harness speaks to the router: all the route core may know of it. A new harness is one more value of this
 * type and one more row of the path table. Nothing here decides a lane or touches the verdict store.
 */
interface HarnessWire {
	/** Picks the stub in `guard`. */
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
	/**
	 * The pi package: `x-phi-session`, which it adds, the Messages codec with pi's bridge, and the Anthropic error shape.
	 * A model id other than one of phi's own names is its own target model, as pi sent it.
	 */
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
