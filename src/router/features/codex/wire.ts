import { Option, Schema } from "effect";

const ContentAsSent = Schema.Array(Schema.Unknown);

const Raw = Schema.Record(Schema.String, Schema.Unknown);

const optionalString = Schema.optionalKey(Schema.String);

const AdditionalTools = Schema.Struct({
	id: Schema.String,
	role: Schema.Literal("developer"),
	tools: Schema.Array(Raw),
	type: Schema.Literal("additional_tools"),
});

const InputMessage = Schema.Struct({
	content: ContentAsSent,
	id: optionalString,
	role: Schema.Literals(["user", "developer"]),
	type: Schema.Literal("message"),
});

const OutputMessage = Schema.Struct({
	content: ContentAsSent,
	id: optionalString,
	phase: optionalString,
	role: Schema.Literal("assistant"),
	status: optionalString,
	type: Schema.Literal("message"),
});

const Reasoning = Schema.Struct({
	content: Schema.optionalKey(Schema.NullOr(ContentAsSent)),
	encrypted_content: Schema.String,
	id: Schema.String,
	summary: ContentAsSent,
	type: Schema.Literal("reasoning"),
});

const FunctionCall = Schema.Struct({
	arguments: Schema.String,
	call_id: Schema.String,
	id: optionalString,
	name: Schema.String,
	namespace: optionalString,
	status: optionalString,
	type: Schema.Literal("function_call"),
});

const CustomToolCall = Schema.Struct({
	call_id: Schema.String,
	id: optionalString,
	input: Schema.String,
	name: Schema.String,
	status: optionalString,
	type: Schema.Literal("custom_tool_call"),
});

const ToolOutput = Schema.Struct({
	call_id: Schema.String,
	id: optionalString,
	output: Schema.Union([Schema.String, ContentAsSent]),
	type: Schema.Literals(["function_call_output", "custom_tool_call_output"]),
});

const AgentMessage = Schema.Struct({
	author: Schema.String,
	content: ContentAsSent,
	id: optionalString,
	recipient: Schema.String,
	type: Schema.Literal("agent_message"),
});

const Item = Schema.Union([
	AdditionalTools,
	InputMessage,
	OutputMessage,
	Reasoning,
	FunctionCall,
	CustomToolCall,
	ToolOutput,
	AgentMessage,
]);

const Reasoned = Schema.Struct({
	context: optionalString,
	effort: optionalString,
	summary: optionalString,
});

const TextFormat = Schema.Struct({ format: Schema.optionalKey(Raw), verbosity: Schema.String });

const CodexId = Schema.String.check(Schema.isPattern(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}(?::\d+)?$/u));

const optionalId = Schema.optionalKey(CodexId);

const Word = Schema.String.check(Schema.isPattern(/^[a-z_-]+$/u));

const optionalWord = Schema.optionalKey(Word);

const optionalBoolean = Schema.optionalKey(Schema.Boolean);

const optionalNumber = Schema.optionalKey(Schema.Finite);

const Compaction = Schema.Struct({ implementation: Word, phase: Word, reason: Word, strategy: Word, trigger: Word });

const ModelSlug = Schema.String.check(Schema.isPattern(/^[\w./:-]+$/u));

const TurnMetadata = Schema.Struct({
	agent_name: optionalString,
	analytics_enabled: optionalBoolean,
	auto_review_enabled: optionalBoolean,
	compaction: Schema.optionalKey(Compaction),
	context_window_id: optionalId,
	history_initialization: optionalWord,
	installation_id: optionalId,
	model: Schema.optionalKey(ModelSlug),
	node_repl_auto_review_required: optionalBoolean,
	node_repl_disabled: optionalBoolean,
	parent_thread_id: optionalId,
	parent_turn_id: optionalId,
	reasoning_effort: optionalWord,
	request_kind: optionalWord,
	root_turn_id: optionalId,
	sandbox: optionalWord,
	sandbox_mode: optionalWord,
	session_id: optionalId,
	subagent_kind: optionalWord,
	thread_id: optionalId,
	thread_source: optionalWord,
	turn_id: optionalId,
	turn_started_at_unix_ms: optionalNumber,
	turn_trigger: optionalWord,
	window_id: optionalId,
	window_number: optionalNumber,
	workspaces: Schema.optionalKey(Schema.Record(Schema.String, Raw)),
});

const AnyJson = Schema.fromJsonString(Schema.Unknown);

const readJson = Schema.decodeUnknownOption(AnyJson);

const writeJson = Schema.encodeOption(AnyJson);

const CompactJson = Schema.String.check(
	Schema.makeFilter((text: string) => Option.contains(Option.flatMap(readJson(text), writeJson), text), {
		expected: "compact JSON with each key once",
	}),
);

const TurnMetadataJson = CompactJson.pipe(Schema.decodeTo(Schema.fromJsonString(TurnMetadata)));

const ClientMetadata = Schema.Struct({
	parent_turn_id: optionalId,
	root_turn_id: optionalId,
	session_id: optionalId,
	thread_id: optionalId,
	turn_id: optionalId,
	"x-codex-installation-id": optionalId,
	"x-codex-parent-thread-id": optionalId,
	"x-codex-turn-metadata": Schema.optionalKey(TurnMetadataJson),
	"x-codex-window-id": optionalId,
	"x-openai-subagent": optionalWord,
});

const Body = Schema.Struct({
	client_metadata: Schema.optionalKey(ClientMetadata),
	include: Schema.Array(Schema.String),
	input: Schema.Array(Schema.Unknown),
	model: Schema.String,
	parallel_tool_calls: Schema.Boolean,
	prompt_cache_key: optionalId,
	reasoning: Reasoned,
	store: Schema.Boolean,
	stream: Schema.Boolean,
	text: Schema.optionalKey(TextFormat),
	tool_choice: Schema.String,
	tools: Schema.optionalKey(Schema.Array(Raw)),
});

const Empty = Schema.Tuple([]);

const InputText = Schema.Struct({ text: Schema.String, type: Schema.Literal("input_text") });

const ReadPart = Schema.Union([
	InputText,
	Schema.Struct({ annotations: Empty, logprobs: Empty, text: Schema.String, type: Schema.Literal("output_text") }),
	Schema.Struct({ encrypted_content: Schema.String, type: Schema.Literal("encrypted_content") }),
]);

type WireItem = typeof Item.Type;

type ReplyItem =
	| Extract<WireItem, { readonly type: "reasoning" | "function_call" | "custom_tool_call" }>
	| typeof OutputMessage.Type;

type LoneItem = Exclude<WireItem, ReplyItem | typeof AdditionalTools.Type>;

export { Body, InputText, Item, Raw, ReadPart };

export type { LoneItem, ReplyItem, WireItem };
