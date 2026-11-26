import { Record, Schema, SchemaTransformation } from "effect";

const Judged = Schema.Unknown;

const Metadata = Schema.Unknown;

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

const flag = Schema.optionalKey(Schema.Boolean);

const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);

const forwarded = {
	cache_control: Schema.Struct({
		ttl: Schema.optionalKey(Schema.Literals(["5m", "1h"])),
		type: Schema.Literal("ephemeral"),
	}),
	caller: Schema.Struct({ type: Schema.Literal("direct") }),
	clear_at: Schema.Literal("next_user_message"),
	is_error: Schema.Boolean,
	output_config: Schema.Struct({ effort: Effort }),
} as const;

type ForwardedKey = keyof typeof forwarded;

const forwardedKeys: ReadonlySet<string> = new Set(Record.keys(forwarded));

const isForwarded = (key: string): key is ForwardedKey => forwardedKeys.has(key);

const cacheControl = Schema.optionalKey(forwarded.cache_control);

const ThinkingDisplay = Schema.Literals(["omitted", "updates", "summarized"]);

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

const NamedTool = Schema.Struct({ name: Schema.String, type: Schema.Literal("tool_reference") });

const DefinedTool = Schema.Struct({ definition: Judged, type: Schema.Literal("tool_definition") });

const ToolAddition = Schema.Struct({
	cache_control: cacheControl,
	tool: Schema.Union([DefinedTool, NamedTool]),
	type: Schema.Literal("tool_addition"),
});

const ToolRemoval = Schema.Struct({
	cache_control: cacheControl,
	tool: NamedTool,
	type: Schema.Literal("tool_removal"),
});

const NoteBlock = Schema.Union([Text, ToolAddition, ToolRemoval, Unreadable]);

const noteContent = Schema.Union([Schema.String, Schema.Array(NoteBlock)]);

const AssistantTurn = Schema.Struct({ content: Schema.Array(AssistantBlock), role: Schema.Literal("assistant") });

const HarnessNote = Schema.Struct({
	clear_at: Schema.optionalKey(forwarded.clear_at),
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

const turns = Schema.Array(Schema.Union([UserTurn, AssistantTurn, HarnessNote, Unreadable]));

const systemBlocks = Schema.optionalKey(Schema.Array(Schema.Union([Text, Unreadable])));

const toolList = Schema.optionalKey(Schema.Array(Schema.Union([Tool, Unreadable])));

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

const JsonString = Schema.fromJsonString(Schema.String);

const JsonText = Schema.fromJsonString(Schema.Unknown);

const LooseCall = Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.Literal("tool_use") });

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

const ContentlessEvent = Schema.Struct({
	type: Schema.Literals(["message_start", "content_block_stop", "ping", "message_delta", "message_stop"]),
});

const EventJson = Schema.fromJsonString(Schema.Union([BlockStart, BlockDelta, Failed, ContentlessEvent]));

type WireBody = typeof Body.Type;

type WireTurn = WireBody["messages"][number];

type WireAssistantBlock = typeof AssistantBlock.Type;

type WireUserBlock = typeof UserBlock.Type;

type WireToolResult = typeof ToolResult.Type;

type WireText = typeof Text.Type;

type WireImage = typeof Image.Type;

type WireToolReference = typeof ToolReference.Type;

type WireNoteBlock = typeof NoteBlock.Type;

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
	WireNoteBlock,
	WireText,
	WireToolReference,
	WireToolResult,
	WireTurn,
	WireUnreadable,
	WireUserBlock,
};
