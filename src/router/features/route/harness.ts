import { Effect, Option, Record, Schema, Struct } from "effect";
import type { Harness, Target } from "#router/features/border/index.ts";
import { cleanLaneKeys, decodeRequest as decodeResponsesRequest } from "#router/features/codex/index.ts";
import { decodeRequest, replyKeys } from "#router/features/anthropic-messages/index.ts";
import type { AccountState } from "#router/client/account-state.ts";
import type { Accounts } from "#router/client/upstream-accounts.ts";
import type { Digest } from "effect/crypto";
import type { Message } from "#router/features/parts/index.ts";
import type { Routing } from "./routing.ts";
import { piWire } from "#shared/pi.ts";

/** A codec's "send this request on the sealed lane", whichever codec refused. */
interface CleanLaneRefused {
	readonly _tag: "CleanLaneRefused";
}

/** A request of any harness, as the route core reads it. Each codec's request is one, with no adapter. */
interface Decoded {
	/** The model the harness named, such as `phi/auto`. */
	readonly model: string;
	readonly messages: readonly Message[];
	/** The body for one lane. The clean lane takes what the border returned for `messages`, same length and order. */
	readonly encode: (target: Target) => Effect.Effect<string, CleanLaneRefused>;
	/** `encode` with every reasoning item dropped from the clean body, for an account that could not read one. Codex alone has it. */
	readonly withoutReasoning?: (target: Target) => Effect.Effect<string, CleanLaneRefused>;
	/** Whether Codex sent it to write a thread's title. Codex alone has it. */
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
	/** The header that names the session, the verdict store's key. */
	readonly sessionHeader: string;
	readonly decode: (
		body: string,
		openWrote: (key: string) => boolean,
	) => Effect.Effect<Decoded, Unreadable, Digest.Digest>;
	/** The reply keys of one completed stream from an open account. */
	readonly replyKeys: (reply: string) => Effect.Effect<readonly string[], { readonly message: string }, Digest.Digest>;
	/** The vendor's error JSON for an answer the router writes itself. */
	readonly errorBody: (status: number, message: string) => Effect.Effect<string>;
}

/**
 * One harness served: the shared routing, the harness's wire, its vendor's accounts and the 429 stamps. The route core's
 * argument.
 */
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

/** Claude Code: `x-claude-code-session-id`, the Messages codec, and the Anthropic error shape it shows. */
const claude: HarnessWire = {
	decode: (body, openWrote) =>
		Effect.mapError(decodeRequest(body, openWrote, "claude"), ({ reason }) => Unreadable.make({ reason })),
	errorBody: (status, message) =>
		Effect.orDie(
			Schema.encodeEffect(AnthropicError)({
				error: { message, type: errorType(status, "api_error") },
				type: "error",
			}),
		),
	harness: "claude",
	replyKeys,
	sessionHeader: "x-claude-code-session-id",
};

/** The model ids the pi package sends inside its provider `phi`, with the model name each stands for. */
const piNames: Readonly<Record<string, string>> = piWire.models;

/**
 * The pi package: `x-phi-session`, which it adds, the Messages codec with pi's bridge, and the Anthropic error shape.
 * A model id other than one of phi's own names is its own target model, as pi sent it.
 */
const pi: HarnessWire = {
	decode: (body, openWrote) =>
		Effect.mapBoth(decodeRequest(body, openWrote, "pi"), {
			onFailure: ({ reason }) => Unreadable.make({ reason }),
			onSuccess: (decoded) =>
				Struct.assign(decoded, {
					model: Option.getOrElse(Record.get(piNames, decoded.model), () => decoded.model),
				}),
		}),
	errorBody: claude.errorBody,
	harness: "pi",
	replyKeys,
	sessionHeader: piWire.sessionHeader,
};

/** The path the pi package's requests take. */
const piMessages = `${piWire.base}/v1/messages` as const;

const OpenAiError = Schema.fromJsonString(
	Schema.Struct({ error: Schema.Struct({ message: Schema.String, type: Schema.String }) }),
);

/** Codex: `session-id`, the Codex codec, the keys of clean-lane replies that completed, and the OpenAI error shape. */
const codex: HarnessWire = {
	decode: (body, openWrote) =>
		Effect.mapError(decodeResponsesRequest(body, openWrote), ({ reason }) => Unreadable.make({ reason })),
	errorBody: (status, message) =>
		Effect.orDie(Schema.encodeEffect(OpenAiError)({ error: { message, type: errorType(status, "server_error") } })),
	harness: "codex",
	replyKeys: cleanLaneKeys,
	sessionHeader: "session-id",
};

export { claude, codex, pi, piMessages };

export type { Decoded, HarnessWire, Serving };
