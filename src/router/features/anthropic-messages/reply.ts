import { Array, Effect, Option, Schema, pipe } from "effect";
import type { AssistantMessage } from "#router/features/parts/index.ts";
import type { ContentKey } from "#router/primitives/content-key.ts";
import type { Digest } from "effect/crypto";
import { LooseCall } from "./wire.ts";
import type { WireAssistantBlock } from "./wire.ts";
import { contentKey } from "#router/primitives/content-key.ts";
import { stubbedCalls } from "#router/features/border/index.ts";
import { stubs } from "#router/features/policy/index.ts";
import { writerOf } from "#router/features/parts/index.ts";

type ReplyContent = AssistantMessage["content"];

type ToolCall = Extract<ReplyContent[number], { readonly type: "toolCall" }>;

type Key = typeof ContentKey.Type;

type HoldsReplyKey = (key: Key) => boolean;

const isLooseCall = Schema.is(LooseCall);

const withheld = { text: stubs.unknown, type: "text" } as const;

type WireToolUse = Extract<WireAssistantBlock, { readonly type: "tool_use" }>;

type ReplyBlock = Exclude<WireAssistantBlock, WireToolUse> | (WireToolUse & { readonly inputJson: string });

interface Reply {
	readonly content: ReplyContent;
	readonly readable: boolean;
	readonly writtenBy: AssistantMessage["writtenBy"];
	readonly streamedOpenPerBlock: readonly boolean[];
}

const namedCall = (block: WireAssistantBlock): readonly ToolCall[] => {
	if (block.type !== "unreadable" || !isLooseCall(block.unreadable)) {
		return [];
	}

	return [{ arguments: "{}", id: block.unreadable.id, name: block.unreadable.name, type: "toolCall" }];
};

const visibleOf = (block: ReplyBlock): ReplyContent => {
	switch (block.type) {
		case "text": {
			return [{ text: block.text, type: "text" }];
		}

		case "tool_use": {
			return [{ arguments: block.inputJson, id: block.id, name: block.name, type: "toolCall" }];
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

const withheldOf = (visible: ReplyContent): ReplyContent => [withheld, ...stubbedCalls(visible)];

const blank = /^\s*$/u;

const contentFieldsOf = (block: ReplyBlock): readonly string[] => {
	switch (block.type) {
		case "text": {
			if (blank.test(block.text)) {
				return [];
			}

			return ["text", block.text];
		}

		case "tool_use": {
			return ["call", block.id, block.name, block.inputJson];
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

const replyKeysOf = Effect.fnUntraced(function* replyKeysOf(
	blocks: readonly ReplyBlock[],
): Effect.fn.Return<readonly Key[], never, Digest.Digest> {
	const content = yield* contentKeyOf(blocks);

	const thinking = yield* Effect.all(
		pipe(
			blocks,
			Array.flatMap((block) => Option.toArray(thinkingKeyOf(block))),
		),
		{ concurrency: 1 },
	);

	return [content, ...thinking];
});

const streamedOpen = (
	block: WireAssistantBlock,
	openWrote: HoldsReplyKey,
): Effect.Effect<boolean, never, Digest.Digest> =>
	Option.match(thinkingKeyOf(block), {
		onNone: () => Effect.succeed(false),
		onSome: (key) => pipe(key, Effect.map(openWrote)),
	});

const replyOf = Effect.fnUntraced(function* replyOf(
	blocks: readonly ReplyBlock[],
	openWrote: HoldsReplyKey,
): Effect.fn.Return<Reply, never, Digest.Digest> {
	const content = yield* contentKeyOf(blocks);
	const writtenBy = writerOf(openWrote(content));

	const streamedOpenPerBlock = yield* Effect.forEach(blocks, (block) => streamedOpen(block, openWrote), {
		concurrency: 1,
	});

	const visible = pipe(blocks, Array.flatMap(visibleOf));

	const unknown = pipe(
		blocks,
		Array.some((block) => block.type === "unreadable"),
	);

	const foreignRedacted = pipe(
		blocks,
		Array.zip(streamedOpenPerBlock),
		Array.some(([block, open]) => block.type === "redacted_thinking" && !open),
	);

	if (unknown || foreignRedacted) {
		return { content: withheldOf(visible), readable: false, streamedOpenPerBlock, writtenBy };
	}

	return { content: visible, readable: true, streamedOpenPerBlock, writtenBy };
});

export { replyKeysOf, replyOf, withheld, withheldOf };

export type { HoldsReplyKey, ReplyBlock };
