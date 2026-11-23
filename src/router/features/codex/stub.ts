import { Array, Effect, Equal, Option, Record, Schema, pipe } from "effect";
import type { ContentEntry, Entry } from "./groups.ts";
import type { Message } from "#router/features/parts/index.ts";
import type { Raw } from "./wire.ts";
import type { WirePart } from "./wire-parts.ts";
import { stubs } from "#router/features/policy/index.ts";

/**
 * The clean lane cannot take this request, so it goes to the sealed lane: what no stub can stand in for is not cleared,
 * holds a blob no clean-lane reply wrote, or is not what the codec reads. That is a list judged whole, such as the tool
 * list, the body's other fields, or an item the codec cannot read that carries a call id.
 */
class CleanLaneRefused extends Schema.TaggedError<CleanLaneRefused, { readonly brand: unique symbol }>()(
	"CleanLaneRefused",
	{},
) {}

/**
 * The field that holds an item's content, and what it holds as the stub. Reasoning has none and goes.
 *
 * @param {ContentEntry} entry The item.
 * @param {string} stub The stub text.
 * @returns {Option.Option<readonly [string, unknown]>} The field and its stubbed value.
 */
const stubField = ({ item }: ContentEntry, stub: string): Option.Option<readonly [string, unknown]> => {
	switch (item.type) {
		case "reasoning": {
			return Option.none();
		}

		case "message":
		case "agent_message": {
			if (item.type === "message" && item.role === "assistant") {
				return Option.some(["content", [{ annotations: [], logprobs: [], text: stub, type: "output_text" }]]);
			}

			return Option.some(["content", [{ text: stub, type: "input_text" }]]);
		}

		case "function_call": {
			return Option.some(["arguments", "{}"]);
		}

		case "custom_tool_call": {
			return Option.some(["input", ""]);
		}

		case "function_call_output":
		case "custom_tool_call_output": {
			return Option.some(["output", stub]);
		}

		default: {
			const unhandled: never = item;

			return unhandled;
		}
	}
};

const textOf = (block: Exclude<Message, { readonly role: "system" }>["content"][number]): Option.Option<string> => {
	if (block.type === "text") {
		return Option.some(block.text);
	}

	return Option.none();
};

/**
 * The stub the border wrote in place of a part: its first text. A part the border passed is unjudged here, so it
 * takes the unknown stub.
 *
 * @param {Message} guarded What the border returned for the part.
 * @param {boolean} passed Whether the border passed the part as sent.
 * @returns {string} The stub text.
 */
const stubOf = (guarded: Message, passed: boolean): string => {
	if (passed) {
		return stubs.unknown;
	}

	if (guarded.role === "system") {
		return guarded.content;
	}

	return pipe(
		Array.findFirst(guarded.content, textOf),
		Option.getOrElse(() => stubs.unknown),
	);
};

/**
 * Each item keeps its place, its ids and its name, and its content becomes the stub.
 *
 * @param {string} stub The stub text.
 * @returns {(entry: ContentEntry) => readonly Raw[]} The item stubbed, or nothing for reasoning.
 */
const stubbed =
	(stub: string) =>
	(entry: ContentEntry): readonly (typeof Raw.Type)[] =>
		Option.match(stubField(entry, stub), {
			onNone: () => [],
			onSome: ([field, value]) => [Record.set(entry.raw, field, value)],
		});

/** What the clean lane gets in place of an item the codec cannot read. */
const unreadStub = { content: [{ text: stubs.unknown, type: "input_text" }], role: "user", type: "message" };

/**
 * Items no stub stands in for: the clean lane gets them, or refuses the request.
 *
 * @param {boolean} passes Whether the clean lane may get them.
 * @param {readonly Raw[]} items The items.
 * @returns {Effect.Effect<readonly Raw[], CleanLaneRefused>} The items, or the refusal.
 */
const orRefused = (
	passes: boolean,
	items: readonly (typeof Raw.Type)[],
): Effect.Effect<readonly (typeof Raw.Type)[], CleanLaneRefused> => {
	if (!passes) {
		return Effect.fail(CleanLaneRefused.make({}));
	}

	return Effect.succeed(items);
};

const raws = (entries: readonly Entry[]): readonly (typeof Raw.Type)[] =>
	pipe(
		entries,
		Array.map(({ raw }) => raw),
	);

/**
 * What the clean lane gets of one part, from what the border returned for it: as sent less the reasoning no
 * clean-lane reply wrote, when the border passed it and nothing in it is unjudged, else each item as the border's stub.
 * The border already refused a tool list that is not cleared. One that holds an unwritten blob, or an item the codec
 * cannot read that carries a call id, refuses the request.
 *
 * @param {WirePart} wirePart The part as wire items.
 * @returns {(guarded: Message) => Effect.Effect<readonly Raw[], CleanLaneRefused>} The items of the part, as sent or
 *   stubbed, from what the border returned for its message.
 */
const cleanItems =
	(wirePart: WirePart) =>
	(guarded: Message): Effect.Effect<readonly (typeof Raw.Type)[], CleanLaneRefused> => {
		if (wirePart.kind === "unread") {
			return orRefused(!wirePart.paired, [unreadStub]);
		}

		if (wirePart.kind === "tools") {
			return orRefused(!wirePart.unjudged, raws(wirePart.entries));
		}

		const passed = Equal.equals(guarded, wirePart.message);

		if (passed && !wirePart.unjudged) {
			return Effect.succeed(raws(wirePart.kept));
		}

		const stub = stubOf(guarded, passed);
		const items = pipe(wirePart.entries, Array.flatMap(stubbed(stub)));

		return Effect.succeed(items);
	};

export { CleanLaneRefused, cleanItems };
