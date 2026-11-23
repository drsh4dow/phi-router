import type { AssistantMessage, Message, ToolResultMessage } from "#router/features/parts/index.ts";
import type { Span } from "./spans.ts";

type SystemMessage = Extract<Message, { readonly role: "system" }>;

type UserMessage = Extract<Message, { readonly role: "user" }>;

/** How the wire spelled a content: a plain string, or blocks whose last one's `cache_control` member a rewrite keeps. */
type Spelling = { readonly kind: "string" } | { readonly kind: "blocks"; readonly kept: readonly string[] };

/** A tool call of the wire, which a rewritten reply writes back under the same id and name. */
interface WireCall {
	readonly id: string;
	readonly name: string;
	/** Its `caller` and `cache_control` members, which a rewrite keeps. */
	readonly kept: readonly string[];
}

/** A thinking block's source text, and whether the open account streamed it, so it may go back to an open account. */
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
			/** The visible blocks. Thinking is apart, since only the account that wrote it may receive it. */
			readonly blocks: readonly string[];
			readonly thinking: readonly Thinking[];
			readonly calls: readonly WireCall[];
			/** The `cache_control` member of the last text block, which the last rewritten text keeps. */
			readonly kept: readonly string[];
	  };

/** A wire message: the runs read from it, and the text the clean lane replaces when one of them changes. */
interface Turn {
	readonly span: Span;
	/** `content` replaces the message's content. A role rewrites the whole message under it, since the codec cannot read it. */
	readonly rewrite: "content" | "assistant" | "system" | "user";
	readonly runs: readonly Run[];
	/** A whole-message rewrite's forwarded members, such as a system note's `output_config`. */
	readonly kept: readonly string[];
}

export type { Run, Spelling, Turn, WireCall };
