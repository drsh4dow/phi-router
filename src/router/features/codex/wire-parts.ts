import { Array, Effect, Option, Schema, pipe } from "effect";
import type { Body, Raw } from "./wire.ts";
import type { ContentEntry, Entry, ItemsOfOneMessage } from "./groups.ts";
import { blobsIn, wroteAll } from "./clean-lane.ts";
import { entriesOf, groupsOf } from "./groups.ts";
import { loneMessage, replyMessage, toolsMessage } from "./read.ts";
import type { Digest } from "effect/crypto";
import type { IsReplyKey } from "./clean-lane.ts";
import type { Lists } from "./frame.ts";
import type { Message } from "#router/features/parts/index.ts";
import type { Read } from "./read.ts";
import { frameOf } from "./frame.ts";

type WirePart =
	| {
			readonly kind: "tools";
			readonly message: Message;
			readonly entries: readonly Entry[];
			readonly unwrittenBlob: boolean;
	  }
	| {
			readonly kind: "content";
			readonly message: Message;
			readonly entries: readonly ContentEntry[];
			readonly withoutUnwrittenReasoning: readonly ContentEntry[];
			readonly unreadPart: boolean;
			readonly unwrittenBlob: boolean;
	  }
	| {
			/** An input item the codec cannot read, which the engine reads as an empty user message with no key. */
			readonly kind: "unread";
			readonly message: Message;
			readonly paired: boolean;
	  };

const stringsOf = (message: Message): readonly string[] => {
	if (message.role === "system") {
		return [
			message.content,
			...pipe(
				message.tools,
				Array.map(({ parameters }) => parameters),
			),
		];
	}

	return pipe(
		message.content,
		Array.flatMap((block) => {
			if (block.type === "text") {
				return [block.text];
			}

			if (block.type === "toolCall") {
				return [block.arguments];
			}

			return [];
		}),
	);
};

const SummaryText = Schema.Struct({ text: Schema.String, type: Schema.Literal("summary_text") });

const readSummary = Schema.decodeUnknownOption(Schema.Array(SummaryText));

/**
 * A reasoning item stays on the clean lane only when a clean-lane reply wrote its blob and each summary text, and it
 * holds no plain reasoning text.
 *
 * @param {CleanLaneWrote} wrote What the session's clean-lane replies wrote.
 * @param {Reasoning} item The reasoning item.
 * @returns {Effect.Effect<boolean, never, Digest.Digest>} Whether it stays.
 */
const reasoningKept = (
	wrote: IsReplyKey,
	item: Extract<ContentEntry["item"], { readonly type: "reasoning" }>,
): Effect.Effect<boolean, never, Digest.Digest> => {
	const plainText = Array.isReadonlyArrayNonEmpty(item.content ?? []);

	return Option.match(readSummary(item.summary, { onExcessProperty: "error" }), {
		onNone: () => Effect.succeed(false),
		onSome: (summary) => {
			const texts = pipe(
				summary,
				Array.map(({ text }) => text),
			);

			return Effect.map(wroteAll(wrote)([item.encrypted_content, ...texts]), (written) => written && !plainText);
		},
	});
};

const keptOnClean =
	(wrote: IsReplyKey) =>
	({ item }: ContentEntry): Effect.Effect<boolean, never, Digest.Digest> => {
		if (item.type === "reasoning") {
			return reasoningKept(wrote, item);
		}

		return Effect.succeed(true);
	};

const unwrittenBlobIn = (message: Message, wrote: IsReplyKey): Effect.Effect<boolean, never, Digest.Digest> => {
	const blobs = pipe(stringsOf(message), Array.flatMap(blobsIn));

	return Effect.map(wroteAll(wrote)(blobs), (written) => !written);
};

const toolListPart = (
	wrote: IsReplyKey,
	tools: readonly (typeof Raw.Type)[],
	entries: readonly Entry[],
): Effect.Effect<WirePart, never, Digest.Digest> =>
	Effect.gen(function* readTools() {
		const message = yield* toolsMessage(tools);
		const unwrittenBlob = yield* unwrittenBlobIn(message, wrote);

		return { entries, kind: "tools", message, unwrittenBlob };
	});

const contentPart =
	(wrote: IsReplyKey, entries: readonly ContentEntry[]) =>
	({ holdsUnreadPart, message }: Read): Effect.Effect<WirePart, never, Digest.Digest> =>
		Effect.gen(function* readContent() {
			const unwrittenBlob = yield* unwrittenBlobIn(message, wrote);
			const withoutUnwrittenReasoning = yield* Effect.filter(entries, keptOnClean(wrote), { concurrency: 1 });

			return {
				entries,
				kind: "content",
				message,
				unreadPart: holdsUnreadPart,
				unwrittenBlob,
				withoutUnwrittenReasoning,
			};
		});

const noLists: Lists = { frame: [], tools: [] };

const unreadMessage: Message = { content: [], role: "user" };

const wirePartOf =
	(wrote: IsReplyKey) =>
	(group: ItemsOfOneMessage): Effect.Effect<WirePart, never, Digest.Digest> => {
		switch (group.kind) {
			case "tools": {
				return toolListPart(wrote, group.tools, group.entries);
			}

			case "lone": {
				return contentPart(wrote, [group.entry])(loneMessage(group.entry.item));
			}

			case "unread": {
				return Effect.succeed({ kind: "unread", message: unreadMessage, paired: group.paired });
			}

			case "reply": {
				const items = pipe(
					group.entries,
					Array.map(({ item }) => item),
				);

				return Effect.flatMap(replyMessage(wrote)(items), contentPart(wrote, group.entries));
			}

			default: {
				const unhandled: never = group;

				return unhandled;
			}
		}
	};

const wirePartsOf =
	(wrote: IsReplyKey) =>
	({
		body,
		raw,
	}: {
		readonly body: typeof Body.Type | undefined;
		readonly raw: typeof Raw.Type;
	}): Effect.Effect<readonly WirePart[], never, Digest.Digest> => {
		const entries = entriesOf(raw);

		const lists = Option.match(Option.fromUndefinedOr(body), {
			onNone: () => noLists,
			onSome: (fields) => frameOf({ body: fields, entries }),
		});

		return Effect.forEach(groupsOf({ entries, lists }), wirePartOf(wrote), { concurrency: 1 });
	};

export { wirePartsOf };

export type { WirePart };
