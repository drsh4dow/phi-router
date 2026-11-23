import { Record, Schema, SchemaTransformation } from "effect";

/**
 * JSON whose source text a part holds whole, so the judge reads every byte of it and its shape is not the codec's
 * concern: a tool call's `input`, a tool's `input_schema`, `safeguards` and `output_config.format`'s schema.
 */
const Judged = Schema.Unknown;

/** The one field the clean lane forwards unjudged: Claude Code's ids, no session content. */
const Metadata = Schema.Unknown;

/** A JSON object, as a block the codec cannot name is. */
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

const flag = Schema.optionalKey(Schema.Boolean);

const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);

/**
 * The members the clean lane carries from a block or message onto the one it writes in its place, each in the closed
 * shape recorded from Claude Code 2.1.325. A member outside its shape refuses the clean lane, so the request goes
 * sealed with its own bytes.
 */
const forwarded = {
	cache_control: Schema.Struct({
		ttl: Schema.optionalKey(Schema.Literals(["5m", "1h"])),
		type: Schema.Literal("ephemeral"),
	}),
	caller: Schema.Struct({ type: Schema.Literal("direct") }),
	is_error: Schema.Boolean,
	output_config: Schema.Struct({ effort: Effort }),
} as const;

type ForwardedKey = keyof typeof forwarded;

const forwardedKeys: ReadonlySet<string> = new Set(Record.keys(forwarded));

const isForwarded = (key: string): key is ForwardedKey => forwardedKeys.has(key);

const cacheControl = Schema.optionalKey(forwarded.cache_control);

const ThinkingDisplay = Schema.Literals(["omitted", "updates", "summarized"]);

/**
 * Top-level fields in their recorded closed shapes. A value outside one fails the request, as ADR 0001 says. pi 1.6.0
 * asks for `summarized` thinking, or turns it off. Claude Code 2.1.330 drops `display` when it sends a request again
 * after a 400.
 */
const ThinkingConfig = Schema.Union([
	Schema.Struct({ display: Schema.optionalKey(ThinkingDisplay), type: Schema.Literal("adaptive") }),
	Schema.Struct({ type: Schema.Literal("disabled") }),
]);

const ClearThinking = Schema.Struct({ keep: Schema.Literal("all"), type: Schema.Literal("clear_thinking_20251015") });

const ContextManagement = Schema.Struct({ edits: Schema.Array(ClearThinking) });

const Format = Schema.Struct({ schema: Judged, type: Schema.Literal("json_schema") });

const OutputConfig = Schema.Struct({ effort: Schema.optionalKey(Effort), format: Schema.optionalKey(Format) });

const ToolChoice = Schema.Struct({ type: Schema.Literal("auto") });

const unreadable = Schema.Struct({ type: Schema.Literal("unreadable"), unreadable: JsonObject });

/**
 * A block, message or tool the codec cannot name: an unknown type or role, or a known one with a key this file does not
 * list. Decoded into its own variant so no branch can mistake it for one it knows.
 */
const Unreadable = JsonObject.pipe(
	Schema.decodeTo(
		unreadable,
		SchemaTransformation.transform({
			decode: (block) => ({ type: "unreadable" as const, unreadable: block }),
			encode: (block) => block.unreadable,
		}),
	),
);

const Text = Schema.Struct({ cache_control: cacheControl, text: Schema.String, type: Schema.Literal("text") });

const source = Schema.Struct({ data: Schema.String, media_type: Schema.String, type: Schema.Literal("base64") });

const Image = Schema.Struct({ cache_control: cacheControl, source, type: Schema.Literal("image") });

/** A ToolSearch result's pointer to a deferred tool, read as a part of its tool result. */
const ToolReference = Schema.Struct({ tool_name: Schema.String, type: Schema.Literal("tool_reference") });

const Thinking = Schema.Struct({ signature: Schema.String, thinking: Schema.String, type: Schema.Literal("thinking") });

const RedactedThinking = Schema.Struct({ data: Schema.String, type: Schema.Literal("redacted_thinking") });

const ToolUse = Schema.Struct({
	cache_control: cacheControl,
	caller: Schema.optionalKey(forwarded.caller),
	id: Schema.String,
	input: Judged,
	name: Schema.String,
	type: Schema.Literal("tool_use"),
});

const resultContent = Schema.Union([
	Schema.String,
	Schema.Array(Schema.Union([Text, Image, ToolReference, Unreadable])),
]);

const ToolResult = Schema.Struct({
	cache_control: cacheControl,
	content: resultContent,
	is_error: flag,
	tool_use_id: Schema.String,
	type: Schema.Literal("tool_result"),
});

const AssistantBlock = Schema.Union([Thinking, RedactedThinking, Text, ToolUse, Unreadable]);

const UserBlock = Schema.Union([Text, Image, ToolResult, Unreadable]);

const UserTurn = Schema.Struct({
	content: Schema.Union([Schema.String, Schema.Array(UserBlock)]),
	role: Schema.Literal("user"),
});

const noteContent = Schema.Union([Schema.String, Schema.Array(Schema.Union([Text, Unreadable]))]);

const AssistantTurn = Schema.Struct({ content: Schema.Array(AssistantBlock), role: Schema.Literal("assistant") });

/** A harness note inside `messages`: the environment block or the token count. */
const SystemNote = Schema.Struct({
	content: noteContent,
	output_config: Schema.optionalKey(forwarded.output_config),
	role: Schema.Literal("system"),
});

const Tool = Schema.Struct({
	defer_loading: flag,
	description: Schema.String,
	input_schema: Judged,
	name: Schema.String,
});

const turns = Schema.Array(Schema.Union([UserTurn, AssistantTurn, SystemNote, Unreadable]));

const systemBlocks = Schema.optionalKey(Schema.Array(Schema.Union([Text, Unreadable])));

const toolList = Schema.optionalKey(Schema.Array(Schema.Union([Tool, Unreadable])));

/**
 * One /v1/messages body as Claude Code 2.1.325 or pi 1.6.0 sends it. Decoded with `onExcessProperty: "error"`, so an unknown
 * top-level key fails and names itself, and an unknown key or type below it makes that message, block, system block or
 * tool `Unreadable`.
 */
const Body = Schema.Struct({
	context_management: Schema.optionalKey(ContextManagement),
	max_tokens: Schema.Finite,
	messages: turns,
	metadata: Schema.optionalKey(Metadata),
	model: Schema.String,
	output_config: Schema.optionalKey(OutputConfig),
	safeguards: Schema.optionalKey(Judged),
	stream: flag,
	system: systemBlocks,
	thinking: Schema.optionalKey(ThinkingConfig),
	tool_choice: Schema.optionalKey(ToolChoice),
	tools: toolList,
});

const BodyJson = Schema.fromJsonString(Body);

/** A string as JSON text, for each string the codec writes fresh. */
const JsonString = Schema.fromJsonString(Schema.String);

/** A value as compact JSON text, the way Claude Code writes a streamed tool input back. */
const JsonText = Schema.fromJsonString(Schema.Unknown);

/** What an unreadable block still tells, read with its other keys ignored: a tool call's id and name. */
const LooseCall = Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.Literal("tool_use") });

/** What an unreadable block still tells, read with its other keys ignored: the call a tool result answers. */
const LooseResult = Schema.Struct({ tool_use_id: Schema.String, type: Schema.Literal("tool_result") });

const Delta = Schema.Union([
	Schema.Struct({ text: Schema.String, type: Schema.Literal("text_delta") }),
	Schema.Struct({ partial_json: Schema.String, type: Schema.Literal("input_json_delta") }),
	Schema.Struct({ thinking: Schema.String, type: Schema.Literal("thinking_delta") }),
	Schema.Struct({ signature: Schema.String, type: Schema.Literal("signature_delta") }),
]);

const BlockStart = Schema.Struct({
	content_block: AssistantBlock,
	index: Schema.Finite,
	type: Schema.Literal("content_block_start"),
});

const BlockDelta = Schema.Struct({ delta: Delta, index: Schema.Finite, type: Schema.Literal("content_block_delta") });

const Failed = Schema.Struct({ type: Schema.Literal("error") });

/** Events that hold no content of the reply. */
const Other = Schema.Struct({
	type: Schema.Literals(["message_start", "content_block_stop", "ping", "message_delta", "message_stop"]),
});

/** One SSE `data:` line, decoded with excess keys ignored: usage and `estimated_tokens` are not content. */
const EventJson = Schema.fromJsonString(Schema.Union([BlockStart, BlockDelta, Failed, Other]));

type WireBody = typeof Body.Type;

type WireTurn = WireBody["messages"][number];

type WireAssistantBlock = typeof AssistantBlock.Type;

type WireUserBlock = typeof UserBlock.Type;

type WireToolResult = typeof ToolResult.Type;

type WireText = typeof Text.Type;

type WireImage = typeof Image.Type;

type WireToolReference = typeof ToolReference.Type;

type WireUnreadable = typeof Unreadable.Type;

type WireDelta = typeof Delta.Type;

type WireEvent = typeof EventJson.Type;

export { BodyJson, EventJson, JsonString, JsonText, LooseCall, LooseResult, forwarded, isForwarded };

export type {
	ForwardedKey,
	WireAssistantBlock,
	WireBody,
	WireDelta,
	WireEvent,
	WireImage,
	WireText,
	WireToolReference,
	WireToolResult,
	WireTurn,
	WireUnreadable,
	WireUserBlock,
};
