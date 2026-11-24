import { Array, Option, Predicate, Schema, pipe } from "effect";
import { Item, Raw } from "./wire.ts";
import type { LoneItem, ReplyItem, WireItem } from "./wire.ts";
import type { Lists } from "./frame.ts";

interface Entry<Item extends WireItem = WireItem> {
	readonly kind: "read";
	readonly item: Item;
	readonly raw: typeof Raw.Type;
}

/** An input item the codec cannot read. `paired` when it carries a `call_id`, so no stub can take its place. */
interface Unread {
	readonly kind: "unread";
	readonly paired: boolean;
}

type InputEntry = Entry | Unread;

type ContentEntry = Entry<LoneItem> | Entry<ReplyItem>;

type ItemsOfOneMessage =
	| { readonly kind: "tools"; readonly tools: readonly (typeof Raw.Type)[]; readonly entries: readonly Entry[] }
	| { readonly kind: "lone"; readonly entry: Entry<LoneItem> }
	| { readonly kind: "reply"; readonly entries: readonly Entry<ReplyItem>[] }
	| Unread;

const readInput = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));

const readItem = Schema.decodeUnknownOption(Item);

const readRaw = Schema.decodeUnknownOption(Raw);

/**
 * Each input item of a body, read when the clean lane may get it as sent, else unread. A body whose `input` is no
 * list has none.
 *
 * @param {Raw} body The body as sent.
 * @returns {readonly InputEntry[]} Its items.
 */
const entriesOf = (body: typeof Raw.Type): readonly InputEntry[] =>
	pipe(
		readInput(body["input"]),
		Option.getOrElse(() => []),
		Array.map((value) =>
			Option.match(Option.all({ item: readItem(value, { onExcessProperty: "error" }), raw: readRaw(value) }), {
				onNone: (): InputEntry => ({ kind: "unread", paired: Predicate.hasProperty(value, "call_id") }),
				onSome: ({ item, raw }): InputEntry => ({ item, kind: "read", raw }),
			}),
		),
	);

const isReplyItem = (item: WireItem): item is ReplyItem =>
	item.type === "reasoning" ||
	item.type === "function_call" ||
	item.type === "custom_tool_call" ||
	(item.type === "message" && item.role === "assistant");

const isReplyEntry = (entry: InputEntry): entry is Entry<ReplyItem> => entry.kind === "read" && isReplyItem(entry.item);

const bothReplies = (left: InputEntry, right: InputEntry): boolean => isReplyEntry(left) && isReplyEntry(right);

const groupOf = (chunk: Array.NonEmptyReadonlyArray<InputEntry>): ItemsOfOneMessage => {
	const [first] = chunk;

	if (first.kind === "unread") {
		return first;
	}

	const { item, raw } = first;

	if (item.type === "additional_tools") {
		return { entries: [first], kind: "tools", tools: item.tools };
	}

	if (isReplyItem(item)) {
		return { entries: pipe(chunk, Array.filter(isReplyEntry)), kind: "reply" };
	}

	return { entry: { item, kind: "read", raw }, kind: "lone" };
};

const listGroups = Array.flatMap((list: readonly (typeof Raw.Type)[]): readonly ItemsOfOneMessage[] =>
	Array.match(list, {
		onEmpty: () => [],
		onNonEmpty: (tools) => [{ entries: [], kind: "tools", tools }],
	}),
);

/**
 * The grouping, in order: the top-level tool list, each item on its own except that a run of reasoning,
 * assistant messages and calls is one reply, then each list of the frame.
 *
 * @param {object} request The request's items and lists.
 * @param {readonly InputEntry[]} request.entries The input items.
 * @param {Lists} request.lists The top-level tool list, and the other lists judged whole and never stubbed.
 * @returns {readonly Group[]} One group per message the engine reads.
 */
const groupsOf = ({
	entries,
	lists: { frame, tools },
}: {
	readonly entries: readonly InputEntry[];
	readonly lists: Lists;
}): readonly ItemsOfOneMessage[] => {
	const items = Array.match(entries, {
		onEmpty: () => [],
		onNonEmpty: (list) => pipe(list, Array.groupWith(bothReplies), Array.map(groupOf)),
	});

	return [...listGroups([tools]), ...items, ...listGroups(frame)];
};

export { entriesOf, groupsOf, isReplyItem };

export type { ContentEntry, Entry, ItemsOfOneMessage, InputEntry };
