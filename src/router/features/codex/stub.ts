import { Array, Effect, Equal, Option, Record, pipe } from "effect";
import type { ContentEntry, Entry } from "./groups.ts";
import { CleanLaneRefused } from "#router/features/border/index.ts";
import type { Message } from "#router/features/parts/index.ts";
import type { Raw } from "./wire.ts";
import type { WirePart } from "./wire-parts.ts";
import { stubs } from "#router/features/policy/index.ts";

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

const stubbed =
	(stub: string) =>
	(entry: ContentEntry): readonly (typeof Raw.Type)[] =>
		Option.match(stubField(entry, stub), {
			onNone: () => [],
			onSome: ([field, value]) => [Record.set(entry.raw, field, value)],
		});

const unreadStub = { content: [{ text: stubs.unknown, type: "input_text" }], role: "user", type: "message" };

const orRefused = (
	passes: boolean,
	items: readonly (typeof Raw.Type)[],
	reason: string,
): Effect.Effect<readonly (typeof Raw.Type)[], CleanLaneRefused> => {
	if (!passes) {
		return Effect.fail(CleanLaneRefused.make({ reason }));
	}

	return Effect.succeed(items);
};

const raws = (entries: readonly Entry[]): readonly (typeof Raw.Type)[] =>
	pipe(
		entries,
		Array.map(({ raw }) => raw),
	);

const cleanItems =
	(wirePart: WirePart) =>
	(guarded: Message): Effect.Effect<readonly (typeof Raw.Type)[], CleanLaneRefused> => {
		if (wirePart.kind === "unread") {
			return orRefused(!wirePart.paired, [unreadStub], "an unread item paired with a tool call");
		}

		if (wirePart.kind === "tools") {
			return orRefused(
				!wirePart.unwrittenBlob,
				raws(wirePart.entries),
				"a tool list holding a blob no open account wrote",
			);
		}

		const passed = Equal.equals(guarded, wirePart.message);

		if (passed && !wirePart.unreadPart && !wirePart.unwrittenBlob) {
			return Effect.succeed(raws(wirePart.withoutUnwrittenReasoning));
		}

		const stub = stubOf(guarded, passed);
		const items = pipe(wirePart.entries, Array.flatMap(stubbed(stub)));

		return Effect.succeed(items);
	};

export { cleanItems };
