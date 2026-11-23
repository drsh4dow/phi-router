import { Array, Effect, Option, Predicate, Schema, pipe } from "effect";
import type { AssistantMessage, Message, Part } from "#router/features/parts/index.ts";
import type { Lookup, Standing } from "#router/features/verdicts/index.ts";
import type { Digest } from "effect/crypto";
import type { Harness } from "./texts.ts";
import { partsOf } from "#router/features/parts/index.ts";
import { stubs as policyStubs } from "#router/features/policy/index.ts";
import { stubsFor } from "./texts.ts";

/** A tool list cannot be stubbed without breaking the calls that name it, so a request whose tools never cleared is refused. */
class ToolsNotCleared extends Schema.TaggedError<ToolsNotCleared, { readonly brand: unique symbol }>()(
	"ToolsNotCleared",
	{},
) {}

interface Checked {
	readonly slot: Part["slot"];
	readonly standing: Standing;
}

type SystemMessage = Extract<Message, { readonly role: "system" }>;

const stubbedCalls = (message: AssistantMessage): AssistantMessage["content"] =>
	pipe(
		message.content,
		Array.flatMap((block) => {
			if (block.type === "toolCall") {
				return [{ arguments: "{}", id: block.id, name: block.name, type: "toolCall" } as const];
			}

			return [];
		}),
	);

const stubbedMessage = (message: Exclude<Message, SystemMessage>, stub: string): Message => {
	const text = { text: stub, type: "text" } as const;

	switch (message.role) {
		case "user": {
			return { content: [text], role: "user" };
		}

		case "toolResult": {
			return { content: [text], isError: message.isError, role: "toolResult", toolCallId: message.toolCallId };
		}

		case "assistant": {
			return { content: [text, ...stubbedCalls(message)], role: "assistant", writtenBy: message.writtenBy };
		}

		default: {
			const unhandled: never = message;

			return unhandled;
		}
	}
};

const isSealed = ({ standing }: Checked): boolean => standing === "sealed";

const isCleared = ({ standing }: Checked): boolean => standing === "cleared";

const stubOf = (checked: readonly Checked[], harness: Harness): string => {
	if (pipe(checked, Array.some(isSealed))) {
		return stubsFor[harness];
	}

	return policyStubs.unknown;
};

const guardedSystem = (message: SystemMessage, checked: readonly Checked[], harness: Harness): SystemMessage => {
	const textOf = (isSlot: (slot: Part["slot"]) => boolean, text: string): string =>
		pipe(
			checked,
			Array.findFirst((part) => isSlot(part.slot) && !isCleared(part)),
			Option.match({ onNone: () => text, onSome: (part) => stubOf([part], harness) }),
		);

	return {
		content: textOf(Predicate.isTagged("SystemContent"), message.content),
		role: "system",
		sections: pipe(
			message.sections,
			Array.map(({ name, text }) => ({
				name,
				text: textOf((slot) => Predicate.isTagged(slot, "SystemSection") && slot.name === name, text),
			})),
		),
		tools: message.tools,
	};
};

const guardedMessage = (message: Message, checked: readonly Checked[], harness: Harness): Message => {
	if (message.role === "system") {
		return guardedSystem(message, checked, harness);
	}

	if (pipe(checked, Array.every(isCleared))) {
		return message;
	}

	return stubbedMessage(message, stubOf(checked, harness));
};

/**
 * The request an open account may receive. Keys each part itself, so it never trusts the lane choice: a cleared part
 * passes, a sealed or never-judged one becomes the stub, and each tool call keeps its id and name. Fails when the tool
 * list never cleared.
 */
const guard = Effect.fn("guard")(function* guard({
	messages,
	lookup,
	harness,
}: {
	readonly messages: readonly Message[];
	readonly lookup: Lookup;
	readonly harness: Harness;
}): Effect.fn.Return<readonly Message[], ToolsNotCleared, Digest.Digest> {
	const checked = yield* Effect.forEach(
		messages,
		(message) =>
			pipe(
				partsOf(message),
				Effect.map((parts) => ({
					message,
					parts: pipe(
						parts,
						Array.map(({ key, slot }): Checked => ({ slot, standing: lookup(key) })),
					),
				})),
			),
		{ concurrency: 1 },
	);

	const toolsNotCleared = pipe(
		checked,
		Array.flatMap(({ parts }) => parts),
		Array.some((part) => Predicate.isTagged(part.slot, "SystemTools") && !isCleared(part)),
	);

	if (toolsNotCleared) {
		return yield* ToolsNotCleared.make({});
	}

	return pipe(
		checked,
		Array.map(({ message, parts }) => guardedMessage(message, parts, harness)),
	);
});

export { ToolsNotCleared, guard };
