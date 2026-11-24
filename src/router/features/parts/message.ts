type Base64 = string;

type JsonSchemaText = string;

interface TextBlock {
	readonly type: "text";
	readonly text: string;
}

interface ImageBlock {
	readonly type: "image";
	readonly mimeType: string;
	readonly data: Base64;
}

interface ToolCall {
	readonly type: "toolCall";
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
}

interface Tool {
	readonly name: string;
	readonly description: string;
	readonly parameters: JsonSchemaText;
}

interface SystemMessage {
	readonly role: "system";
	readonly content: string;
	readonly sections: readonly { readonly name: string; readonly text: string }[];
	readonly tools: readonly Tool[];
}

interface UserMessage {
	readonly role: "user";
	readonly content: readonly (TextBlock | ImageBlock)[];
}

interface AssistantMessage {
	readonly role: "assistant";
	readonly content: readonly (TextBlock | ToolCall)[];
	readonly writtenBy: "open-account" | "other";
}

interface ToolResultMessage {
	readonly role: "toolResult";
	readonly toolCallId: string;
	readonly content: readonly (TextBlock | ImageBlock)[];
	readonly isError: boolean;
}

type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export type { AssistantMessage, ImageBlock, Message, SystemMessage, TextBlock, ToolCall, ToolResultMessage };
