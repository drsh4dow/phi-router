import type { AssistantMessage, Message, ToolResultMessage } from "#router/features/parts/index.ts";
import type { Span } from "./spans.ts";

type SystemMessage = Extract<Message, { readonly role: "system" }>;

type UserMessage = Extract<Message, { readonly role: "user" }>;

/** How the wire spelled a content: a plain string, or blocks whose last one's `cache_control` member a rewrite keeps. */
type Spelling = { readonly kind: "string" } | { readonly kind: "blocks"; readonly kept: readonly string[] };

interface WireCall {
	readonly id: string;
	readonly name: string;
	/** Its `caller` and `cache_control` members, which a rewrite keeps. */
	readonly kept: readonly string[];
}

interface Thinking {
	readonly source: string;
	readonly streamed: boolean;
}

/**
 * One engine message beside what the clean lane needs to write it back. `blocks` is the source text of its wire blocks,
 * sent as is while the border returns `message` unchanged. `readable` is false when the wire holds something the codec
 * cannot name, and then `message` reads the unknown stub and the clean lane always rewrites the run.
 */
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
			/** The `is_error` and `cache_control` members of the wire block, which a rewrite keeps. */
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

/** A wire message: the runs read from it, and the text the clean lane replaces when one of them changes. */
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
