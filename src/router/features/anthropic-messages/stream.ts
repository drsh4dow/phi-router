import { Array, Effect, Option, Schema, String as Str, Struct, pipe } from "effect";
import { EventJson, JsonText } from "./wire.ts";
import type { WireAssistantBlock, WireDelta, WireEvent } from "./wire.ts";
import type { ContentKey } from "#router/primitives/content-key.ts";
import type { Digest } from "effect/crypto";
import type { ReplyBlock } from "./reply.ts";
import { replyKeysOf } from "./reply.ts";

type Key = typeof ContentKey.Type;

type BlockStart = Extract<WireEvent, { readonly type: "content_block_start" }>;

const jsonText = Schema.encodeEffect(JsonText);

/** A streamed reply the codec cannot fold: an `error` event, an unknown event or delta, or no `message_stop`. */
class UnreadableReply extends Schema.TaggedError<UnreadableReply, { readonly brand: unique symbol }>()(
	"UnreadableReply",
	{ reason: Schema.String },
) {}

/** One block of a streamed reply as its deltas build it, and the tool input JSON text so far. */
interface Building {
	readonly block: WireAssistantBlock;
	readonly json: string;
}

/**
 * A block with one more delta applied.
 *
 * @param {Building} building The block so far.
 * @param {WireDelta} delta The next delta at its index.
 * @returns {Option.Option<Building>} The block, or none when the delta fits no block of its type.
 */
const applied = ({ block, json }: Building, delta: WireDelta): Option.Option<Building> => {
	if (delta.type === "text_delta" && block.type === "text") {
		return Option.some({ block: Struct.assign(block, { text: block.text + delta.text }), json });
	}

	if (delta.type === "thinking_delta" && block.type === "thinking") {
		return Option.some({ block: Struct.assign(block, { thinking: block.thinking + delta.thinking }), json });
	}

	if (delta.type === "signature_delta" && block.type === "thinking") {
		return Option.some({ block: Struct.assign(block, { signature: block.signature + delta.signature }), json });
	}

	if (delta.type === "input_json_delta" && block.type === "tool_use") {
		return Option.some({ block, json: json + delta.partial_json });
	}

	return Option.none();
};

const unreadable = (reason: string): UnreadableReply => UnreadableReply.make({ reason });

/**
 * A streamed tool input, written back compactly, the way Claude Code echoes an input it did not change.
 *
 * @param {Building} building The block and its input text.
 * @returns {Effect.Effect<ReplyBlock, UnreadableReply>} The finished block.
 */
const finished = ({ block, json }: Building): Effect.Effect<ReplyBlock, UnreadableReply> => {
	if (block.type !== "tool_use") {
		return Effect.succeed({ block, input: "" });
	}

	if (Str.isEmpty(json)) {
		return Effect.map(Effect.orDie(jsonText(block.input)), (input) => ({ block, input }));
	}

	return Schema.decodeEffect(JsonText)(json).pipe(
		Effect.flatMap((parsed) => jsonText(parsed)),
		Effect.mapBoth({
			onFailure: (failure) => unreadable(`tool input ${failure.message}`),
			onSuccess: (input) => ({ block, input }),
		}),
	);
};

const deltasAt = (events: readonly WireEvent[], index: number): readonly WireDelta[] =>
	pipe(
		events,
		Array.flatMap((event) => {
			if (event.type === "content_block_delta" && event.index === index) {
				return [event.delta];
			}

			return [];
		}),
	);

const builtAt = (events: readonly WireEvent[], start: BlockStart): Option.Option<Building> => {
	let building = Option.some<Building>({ block: start.content_block, json: "" });

	for (const delta of deltasAt(events, start.index)) {
		building = pipe(
			building,
			Option.flatMap((open) => applied(open, delta)),
		);
	}

	return building;
};

const blocksOf = (events: readonly WireEvent[]): Effect.Effect<readonly ReplyBlock[], UnreadableReply> => {
	const starts = pipe(
		events,
		Array.flatMap((event) => {
			if (event.type === "content_block_start") {
				return [event];
			}

			return [];
		}),
	);

	return Effect.forEach(
		starts,
		(start) =>
			Effect.fromOption(builtAt(events, start)).pipe(
				Effect.mapError(() => unreadable(`a delta fits no block at ${String(start.index)}`)),
				Effect.flatMap(finished),
			),
		{ concurrency: 1 },
	);
};

const dataPrefix = "data:";

const decodeEvent = Schema.decodeEffect(EventJson);

const eventsOf = (sse: string): Effect.Effect<readonly WireEvent[], UnreadableReply> => {
	const lines = pipe(
		sse,
		Str.split("\n"),
		Array.filter(Str.startsWith(dataPrefix)),
		Array.map(Str.slice(dataPrefix.length)),
	);

	return Effect.forEach(
		lines,
		(line) => Effect.mapError(decodeEvent(line), (failure) => unreadable(failure.message)),
		{
			concurrency: 1,
		},
	);
};

/**
 * The keys a completed open-account stream leaves for the caller to store: one for the reply's content, which says the
 * open account wrote an echo with the same text and calls, and one for each thinking block, which says that block may
 * go back to an open account. Reads the whole SSE text after the route has streamed it through.
 */
const replyKeys = Effect.fn("replyKeys")(function* replyKeys(
	sse: string,
): Effect.fn.Return<readonly Key[], UnreadableReply, Digest.Digest> {
	const events = yield* eventsOf(sse);

	if (
		pipe(
			events,
			Array.some((event) => event.type === "error"),
		)
	) {
		return yield* unreadable("the reply holds an error event");
	}

	if (
		!pipe(
			events,
			Array.some((event) => event.type === "message_stop"),
		)
	) {
		return yield* unreadable("the reply ends before message_stop");
	}

	const blocks = yield* blocksOf(events);

	return yield* replyKeysOf(blocks);
});

export { UnreadableReply, replyKeys };
