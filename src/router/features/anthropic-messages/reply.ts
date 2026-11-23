import { Array, Effect, Option, Schema, pipe } from "effect";
import type { AssistantMessage } from "#router/features/parts/index.ts";
import type { ContentKey } from "#router/primitives/content-key.ts";
import type { Digest } from "effect/crypto";
import { LooseCall } from "./wire.ts";
import type { WireAssistantBlock } from "./wire.ts";
import { contentKey } from "#router/primitives/content-key.ts";
import { stubs } from "#router/features/policy/index.ts";

type ReplyContent = AssistantMessage["content"];

type ToolCall = Extract<ReplyContent[number], { readonly type: "toolCall" }>;

type Key = typeof ContentKey.Type;

/** Whether the router's record of completed open-account streams holds a key `replyKeys` gave. */
type OpenWrote = (key: Key) => boolean;

const isLooseCall = Schema.is(LooseCall);

/** What the engine reads in place of a run holding a block the codec cannot name, so the run stays unjudged. */
const withheld = { text: stubs.unknown, type: "text" } as const;

/** A reply's wire block, and for a tool_use its input as JSON text: as a request spelled it, or compact from a stream. */
interface ReplyBlock {
	readonly block: WireAssistantBlock;
	readonly input: string;
}

/** An assistant turn as the engine reads it, and for each of its blocks whether the open account streamed it. */
interface Reply {
	readonly content: ReplyContent;
	readonly readable: boolean;
	readonly writtenBy: AssistantMessage["writtenBy"];
	readonly streamed: readonly boolean[];
}

/**
 * A tool call an unreadable block still names, with no arguments, so a withheld reply keeps every call beside its
 * result.
 *
 * @param {WireAssistantBlock} block An unreadable block.
 * @returns {readonly ToolCall[]} The call, when the block is a tool_use with an id and a name.
 */
const namedCall = (block: WireAssistantBlock): readonly ToolCall[] => {
	if (block.type !== "unreadable" || !isLooseCall(block.unreadable)) {
		return [];
	}

	return [{ arguments: "{}", id: block.unreadable.id, name: block.unreadable.name, type: "toolCall" }];
};

const visibleOf = ({ block, input }: ReplyBlock): ReplyContent => {
	switch (block.type) {
		case "text": {
			return [{ text: block.text, type: "text" }];
		}

		case "tool_use": {
			return [{ arguments: input, id: block.id, name: block.name, type: "toolCall" }];
		}

		case "unreadable": {
			return namedCall(block);
		}

		case "thinking":
		case "redacted_thinking": {
			return [];
		}

		default: {
			const unhandled: never = block;

			return unhandled;
		}
	}
};

/**
 * The unknown stub and each tool call with no arguments, which the engine reads for a reply it cannot judge.
 *
 * @param {ReplyContent} visible The reply's visible content.
 * @returns {ReplyContent} The withheld content.
 */
const withheldOf = (visible: ReplyContent): ReplyContent => {
	const calls = pipe(
		visible,
		Array.flatMap((block) => {
			if (block.type === "toolCall") {
				return [{ arguments: "{}", id: block.id, name: block.name, type: "toolCall" } as const];
			}

			return [];
		}),
	);

	return [withheld, ...calls];
};

const blank = /^\s*$/u;

/**
 * What of one block the content key reads: non-blank text, which Claude Code echoes as streamed, and each tool call's
 * id, name and input. A blank text block, which Claude Code drops, and thinking, which has keys of its own, add nothing.
 *
 * @param {ReplyBlock} block A block of the reply and its input text.
 * @returns {readonly string[]} Its fields in the key.
 */
const contentFieldsOf = ({ block, input }: ReplyBlock): readonly string[] => {
	switch (block.type) {
		case "text": {
			if (blank.test(block.text)) {
				return [];
			}

			return ["text", block.text];
		}

		case "tool_use": {
			return ["call", block.id, block.name, input];
		}

		case "unreadable": {
			return ["unreadable"];
		}

		case "thinking":
		case "redacted_thinking": {
			return [];
		}

		default: {
			const unhandled: never = block;

			return unhandled;
		}
	}
};

/**
 * A thinking block's own key: its text and signature, or a redacted block's data.
 *
 * @param {WireAssistantBlock} block A block of the reply.
 * @returns {Option.Option<Effect.Effect<Key, never, Digest.Digest>>} The key, none for a block that is not thinking.
 */
const thinkingKeyOf = (block: WireAssistantBlock): Option.Option<Effect.Effect<Key, never, Digest.Digest>> => {
	if (block.type === "thinking") {
		return Option.some(contentKey(["thinking", block.thinking, block.signature]));
	}

	if (block.type === "redacted_thinking") {
		return Option.some(contentKey(["redacted", block.data]));
	}

	return Option.none();
};

const contentKeyOf = (blocks: readonly ReplyBlock[]): Effect.Effect<Key, never, Digest.Digest> =>
	contentKey(["reply", ...pipe(blocks, Array.flatMap(contentFieldsOf))]);

/**
 * Every key a streamed reply leaves: its content key, then one per thinking block.
 *
 * @param {readonly ReplyBlock[]} blocks The reply's blocks.
 * @returns {Effect.Effect<readonly Key[], never, Digest.Digest>} The keys.
 */
const replyKeysOf = Effect.fnUntraced(function* replyKeysOf(
	blocks: readonly ReplyBlock[],
): Effect.fn.Return<readonly Key[], never, Digest.Digest> {
	const content = yield* contentKeyOf(blocks);

	const thinking = yield* Effect.all(
		pipe(
			blocks,
			Array.flatMap(({ block }) => Option.toArray(thinkingKeyOf(block))),
		),
		{ concurrency: 1 },
	);

	return [content, ...thinking];
});

/**
 * Whether the open account streamed this block: a thinking block whose own key `openWrote` holds.
 *
 * @param {WireAssistantBlock} block A block of the reply.
 * @param {OpenWrote} openWrote The router's record of what open accounts streamed.
 * @returns {Effect.Effect<boolean, never, Digest.Digest>} Whether the block may go back to an open account.
 */
const streamedOpen = (block: WireAssistantBlock, openWrote: OpenWrote): Effect.Effect<boolean, never, Digest.Digest> =>
	Option.match(thinkingKeyOf(block), {
		onNone: () => Effect.succeed(false),
		onSome: (key) => pipe(key, Effect.map(openWrote)),
	});

const writerOf = (open: boolean): AssistantMessage["writtenBy"] => {
	if (open) {
		return "open-account";
	}

	return "other";
};

/**
 * An assistant turn as the engine reads it. It is `open-account` only when its text and calls are what an open
 * account streamed. Redacted thinking hides what the reply was written from, so a reply holding redacted thinking the
 * open account did not stream is unreadable.
 */
const replyOf = Effect.fnUntraced(function* replyOf(
	blocks: readonly ReplyBlock[],
	openWrote: OpenWrote,
): Effect.fn.Return<Reply, never, Digest.Digest> {
	const content = yield* contentKeyOf(blocks);
	const writtenBy = writerOf(openWrote(content));
	const streamed = yield* Effect.forEach(blocks, ({ block }) => streamedOpen(block, openWrote), { concurrency: 1 });
	const visible = pipe(blocks, Array.flatMap(visibleOf));

	const unknown = pipe(
		blocks,
		Array.some(({ block }) => block.type === "unreadable"),
	);

	const foreignRedacted = pipe(
		blocks,
		Array.zip(streamed),
		Array.some(([{ block }, open]) => block.type === "redacted_thinking" && !open),
	);

	if (unknown || foreignRedacted) {
		return { content: withheldOf(visible), readable: false, streamed, writtenBy };
	}

	return { content: visible, readable: true, streamed, writtenBy };
});

export { replyKeysOf, replyOf, withheld, withheldOf };

export type { OpenWrote, ReplyBlock };
