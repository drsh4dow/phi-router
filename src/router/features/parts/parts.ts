import { Array, Effect, Schema, pipe } from "effect";
import type { ImageBlock, Message, SystemMessage, TextBlock, ToolCall } from "./message.ts";
import type { ContentKey } from "#router/primitives/content-key.ts";
import type { Digest } from "effect/crypto";
import type { Image } from "#router/features/policy/index.ts";
import { contentKey } from "#router/primitives/content-key.ts";

const MessageSlot = Schema.TaggedStruct("Message", {});

const SystemContent = Schema.TaggedStruct("SystemContent", {});

const SystemSection = Schema.TaggedStruct("SystemSection", { name: Schema.String });

const SystemTools = Schema.TaggedStruct("SystemTools", {});

const Slot = Schema.Union([MessageSlot, SystemContent, SystemSection, SystemTools]);

interface Part {
	readonly key: typeof ContentKey.Type;
	readonly slot: typeof Slot.Type;
}

type Block = TextBlock | ImageBlock | ToolCall;

const fieldsOf = (block: Block): readonly string[] => {
	switch (block.type) {
		case "text": {
			return ["text", block.text];
		}

		case "image": {
			return ["image", block.mimeType, block.data];
		}

		case "toolCall": {
			return ["call", block.id, block.name, block.arguments];
		}

		default: {
			const unhandled: never = block;

			return unhandled;
		}
	}
};

const textsOf = (blocks: readonly Block[]): readonly string[] =>
	pipe(
		blocks,
		Array.flatMap((block) => {
			if (block.type === "text") {
				return [block.text];
			}

			if (block.type === "toolCall") {
				return [`${block.name}(${block.arguments})`];
			}

			return [];
		}),
	);

const imagesOf = (blocks: readonly Block[]): readonly Image[] =>
	pipe(
		blocks,
		Array.flatMap((block) => {
			if (block.type === "image") {
				return [{ data: block.data, mimeType: block.mimeType }];
			}

			return [];
		}),
	);

interface Unit extends Part {
	readonly texts: readonly string[];
	readonly images: readonly Image[];
}

const unitOf = Effect.fnUntraced(function* unitOf({
	fields,
	blocks,
	slot,
}: {
	readonly fields: readonly string[];
	readonly blocks: readonly Block[];
	readonly slot: typeof Slot.Type;
}): Effect.fn.Return<Unit, never, Digest.Digest> {
	const key = yield* contentKey([...fields, ...pipe(blocks, Array.flatMap(fieldsOf))]);

	return { images: imagesOf(blocks), key, slot, texts: textsOf(blocks) };
});

const toolsUnit = Effect.fnUntraced(function* toolsUnit({
	tools,
}: SystemMessage): Effect.fn.Return<readonly Unit[], never, Digest.Digest> {
	if (Array.isReadonlyArrayEmpty(tools)) {
		return [];
	}

	const added = pipe(
		tools,
		Array.map(({ name, description, parameters }) => [name, description, parameters]),
	);

	const key = yield* contentKey([
		"system-tools",
		...pipe(
			added,
			Array.flatMap((tool) => ["add", ...tool]),
		),
	]);

	return [{ images: [], key, slot: SystemTools.make({}), texts: pipe(added, Array.map(Array.join("\n"))) }];
});

const systemUnits = Effect.fnUntraced(function* systemUnits(
	message: SystemMessage,
): Effect.fn.Return<readonly Unit[], never, Digest.Digest> {
	const content = yield* unitOf({
		blocks: [{ text: message.content, type: "text" }],
		fields: ["system-content"],
		slot: SystemContent.make({}),
	});

	const sections = yield* Effect.all(
		pipe(
			message.sections,
			Array.map(({ name, text }) =>
				unitOf({
					blocks: [{ text, type: "text" }],
					fields: ["system-section", name],
					slot: SystemSection.make({ name }),
				}),
			),
		),
		{ concurrency: 1 },
	);

	const tools = yield* toolsUnit(message);

	return [content, ...sections, ...tools];
});

const unitsOf = Effect.fnUntraced(function* unitsOf(
	message: Message,
): Effect.fn.Return<readonly Unit[], never, Digest.Digest> {
	switch (message.role) {
		case "system": {
			return yield* systemUnits(message);
		}

		case "user": {
			return [yield* unitOf({ blocks: message.content, fields: ["user"], slot: MessageSlot.make({}) })];
		}

		case "toolResult": {
			const fields = ["tool", "isError", String(message.isError)];

			return [yield* unitOf({ blocks: message.content, fields, slot: MessageSlot.make({}) })];
		}

		case "assistant": {
			return [yield* unitOf({ blocks: message.content, fields: ["assistant"], slot: MessageSlot.make({}) })];
		}

		default: {
			const unhandled: never = message;

			return unhandled;
		}
	}
});

/**
 * The stub-able parts of one message and their keys. Keys leave out `toolCallId` and `writtenBy`, so a retry, a resend
 * after compaction and a repeated file read share a key.
 */
const partsOf = Effect.fnUntraced(function* partsOf(
	message: Message,
): Effect.fn.Return<readonly Part[], never, Digest.Digest> {
	const units = yield* unitsOf(message);

	return pipe(
		units,
		Array.map(({ key, slot }) => ({ key, slot })),
	);
});

export { partsOf, textsOf, unitsOf };

export type { Part };
