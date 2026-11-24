import { Array, Effect, Option, Predicate, Schema, pipe } from "effect";
import type { AssistantMessage, Message } from "#router/features/parts/index.ts";
import type { LoneItem, Raw, ReplyItem } from "./wire.ts";
import { canonicalText, rawText } from "./json.ts";
import type { CleanLaneWrote } from "./clean-lane.ts";
import type { Digest } from "effect/crypto";
import { ReadPart } from "./wire.ts";
import { cleanLaneItemKey } from "./clean-lane.ts";

interface Read {
	readonly message: Message;
	readonly holdsUnreadPart: boolean;
}

interface Texts {
	readonly texts: readonly string[];
	readonly holdsUnreadPart: boolean;
}

type SystemMessage = Extract<Message, { readonly role: "system" }>;

type TextBlock = Extract<AssistantMessage["content"][number], { readonly type: "text" }>;

type Tool = SystemMessage["tools"][number];

const readPart = Schema.decodeUnknownOption(ReadPart);

const encodeContent = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const readToolEntry = Schema.decodeUnknownOption(
	Schema.Struct({
		description: Schema.optionalKey(Schema.String),
		name: Schema.optionalKey(Schema.String),
		type: Schema.String,
	}),
);

const textOf = (part: typeof ReadPart.Type): string => {
	if (part.type === "encrypted_content") {
		return part.encrypted_content;
	}

	return part.text;
};

const readContent = (content: readonly unknown[] | string): Texts => {
	if (Predicate.isString(content)) {
		return { holdsUnreadPart: false, texts: [content] };
	}

	const parts = pipe(
		content,
		Array.map((part) => readPart(part, { onExcessProperty: "error" })),
	);

	return {
		holdsUnreadPart: pipe(parts, Array.some(Option.isNone)),
		texts: pipe(parts, Array.getSomes, Array.map(textOf)),
	};
};

const textBlocks = (texts: readonly string[]): readonly TextBlock[] =>
	pipe(
		texts,
		Array.map((text): TextBlock => ({ text, type: "text" })),
	);

const loneMessage = (item: LoneItem): Read => {
	switch (item.type) {
		case "function_call_output":
		case "custom_tool_call_output": {
			const { holdsUnreadPart, texts } = readContent(item.output);
			const content = textBlocks(texts);

			return { holdsUnreadPart, message: { content, isError: false, role: "toolResult", toolCallId: item.call_id } };
		}

		case "message":
		case "agent_message": {
			const { holdsUnreadPart, texts } = readContent(item.content);

			if (item.type === "message" && item.role === "developer") {
				return {
					holdsUnreadPart,
					message: { content: Array.join(texts, "\n"), role: "system", sections: [], tools: [] },
				};
			}

			return { holdsUnreadPart, message: { content: textBlocks(texts), role: "user" } };
		}

		default: {
			const unhandled: never = item;

			return unhandled;
		}
	}
};

const replyContent = (item: ReplyItem): Effect.Effect<AssistantMessage["content"]> => {
	switch (item.type) {
		case "reasoning": {
			return Effect.succeed([]);
		}

		case "message": {
			return Effect.succeed(textBlocks(readContent(item.content).texts));
		}

		case "function_call": {
			return Effect.map(canonicalText(item.arguments), (args) => [
				{ arguments: args, id: item.call_id, name: item.name, type: "toolCall" as const },
			]);
		}

		case "custom_tool_call": {
			return Effect.succeed([{ arguments: item.input, id: item.call_id, name: item.name, type: "toolCall" }]);
		}

		default: {
			const unhandled: never = item;

			return unhandled;
		}
	}
};

const unreadIn = (item: ReplyItem): boolean => item.type === "message" && readContent(item.content).holdsUnreadPart;

const writerOf = (written: boolean): AssistantMessage["writtenBy"] => {
	if (written) {
		return "open-account";
	}

	return "other";
};

const itemKey = Effect.fnUntraced(function* itemKey(item: ReplyItem) {
	const content = yield* replyContent(item);
	const text = yield* Effect.orDie(encodeContent(content));

	const key = pipe(
		Option.fromUndefinedOr(item.id),
		Option.map((id) => cleanLaneItemKey({ content: text, id })),
	);

	return yield* Effect.transposeOption(key);
});

const replyMessage =
	(wrote: CleanLaneWrote) =>
	(items: readonly ReplyItem[]): Effect.Effect<Read, never, Digest.Digest> =>
		Effect.gen(function* readReply() {
			const contents = yield* Effect.forEach(items, replyContent, { concurrency: 1 });
			const keys = yield* Effect.forEach(items, itemKey, { concurrency: 1 });
			const written = Option.match(Option.all(keys), { onNone: () => false, onSome: Array.every(wrote) });

			return {
				holdsUnreadPart: pipe(items, Array.some(unreadIn)),
				message: { content: Array.flatten(contents), role: "assistant", writtenBy: writerOf(written) },
			};
		});

const toolOf = (entry: typeof Raw.Type): Effect.Effect<Tool> =>
	Effect.map(rawText(entry), (parameters) =>
		Option.match(readToolEntry(entry), {
			onNone: () => ({ description: "", name: "", parameters }),
			onSome: ({ description = "", name, type }) => ({ description, name: name ?? type, parameters }),
		}),
	);

const toolsMessage = (tools: readonly (typeof Raw.Type)[]): Effect.Effect<SystemMessage> =>
	Effect.map(Effect.forEach(tools, toolOf, { concurrency: 1 }), (list): SystemMessage => ({
		content: "",
		role: "system",
		sections: [],
		tools: list,
	}));

export { itemKey, loneMessage, replyMessage, toolsMessage };

export type { Read };
