import type { AssistantMessage, Message, ToolResultMessage } from "#router/features/parts/index.ts";
import type { Span } from "./spans.ts";

type SystemMessage = Extract<Message, { readonly role: "system" }>;

type UserMessage = Extract<Message, { readonly role: "user" }>;

type Spelling = { readonly kind: "string" } | { readonly kind: "blocks"; readonly kept: readonly string[] };

interface WireCall {
	readonly id: string;
	readonly name: string;
	readonly kept: readonly string[];
}

interface Thinking {
	readonly source: string;
	readonly streamed: boolean;
}

type Run =
	| {
			readonly kind: "prompt";
			readonly readable: boolean;
			readonly message: UserMessage;
			readonly blocks: readonly string[];
			readonly content: Spelling;
	  }
	| {
			readonly kind: "note";
			readonly readable: boolean;
			readonly message: SystemMessage;
			readonly blocks: readonly string[];
			readonly content: Spelling;
	  }
	| {
			readonly kind: "result";
			readonly readable: boolean;
			readonly message: ToolResultMessage;
			readonly blocks: readonly string[];
			readonly content: Spelling;
			readonly kept: readonly string[];
	  }
	| {
			readonly kind: "reply";
			readonly readable: boolean;
			readonly message: AssistantMessage;
			readonly blocks: readonly string[];
			readonly thinking: readonly Thinking[];
			readonly calls: readonly WireCall[];
			readonly kept: readonly string[];
	  };

type Turn =
	| { readonly replaces: "content"; readonly span: Span; readonly runs: readonly Run[] }
	| {
			readonly replaces: "message";
			readonly role: "assistant" | "system" | "user";
			readonly span: Span;
			readonly runs: readonly Run[];
			readonly kept: readonly string[];
	  };

export type { Run, Spelling, Turn, WireCall };
