interface TextBlock {
	readonly type: "text";
	readonly text: string;
}

interface ImageBlock {
	readonly type: "image";
	readonly mimeType: string;
	/** Base64. */
	readonly data: string;
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
	/** The JSON schema text. */
	readonly parameters: string;
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
	/** `open-account` when an open account wrote the reply, so rules alone decide it; else `other`, which is judged. */
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
