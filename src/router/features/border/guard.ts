import { Array, Effect, Option, Predicate, Schema, pipe } from "effect";
import type { AssistantMessage, Message, Part } from "#router/features/parts/index.ts";
import type { Lookup, Standing } from "#router/features/verdicts/index.ts";
import type { Digest } from "effect/crypto";
import type { Handle } from "#router/primitives/handle.ts";
import type { Harness } from "./texts.ts";
import type { SealedPart } from "#router/client/sealed-store.ts";
import { stubs as policyStubs } from "#router/features/policy/index.ts";
import { sealedStub } from "./texts.ts";
import { unitsOf } from "#router/features/parts/index.ts";

class ToolsNotCleared extends Schema.TaggedError<ToolsNotCleared, { readonly brand: unique symbol }>()(
	"ToolsNotCleared",
	{},
) {}

interface Checked {
	readonly slot: Part["slot"];
	readonly standing: Standing;
	readonly stub: string;
}

type Keep<Failure> = (parts: readonly SealedPart[]) => Effect.Effect<ReadonlyMap<string, typeof Handle.Type>, Failure>;

type SystemMessage = Extract<Message, { readonly role: "system" }>;

const stubbedCalls = (content: AssistantMessage["content"]): AssistantMessage["content"] =>
	pipe(
		content,
		Array.flatMap((block) => {
			if (block.type === "toolCall") {
				return [{ arguments: "{}", id: block.id, name: block.name, type: "toolCall" } as const];
			}

			return [];
		}),
	);

const stubbedMessage =
	(stub: string) =>
	(message: Exclude<Message, SystemMessage>): Message => {
		const text = { text: stub, type: "text" } as const;

		switch (message.role) {
			case "user": {
				return { content: [text], role: "user" };
			}

			case "toolResult": {
				return { content: [text], isError: message.isError, role: "toolResult", toolCallId: message.toolCallId };
			}

			case "assistant": {
				return {
					content: [text, ...stubbedCalls(message.content)],
					role: "assistant",
					writtenBy: message.writtenBy,
				};
			}

			default: {
				const unhandled: never = message;

				return unhandled;
			}
		}
	};

const isSealed = ({ standing }: Checked): boolean => standing === "sealed";

const isCleared = ({ standing }: Checked): boolean => standing === "cleared";

const stubOf = (checked: readonly Checked[]): string =>
	pipe(
		checked,
		Array.findFirst(isSealed),
		Option.match({ onNone: () => policyStubs.unknown, onSome: ({ stub }) => stub }),
	);

const guardedSystem = (message: SystemMessage, checked: readonly Checked[]): SystemMessage => {
	const textOf = (isSlot: (slot: Part["slot"]) => boolean, text: string): string =>
		pipe(
			checked,
			Array.findFirst((part) => isSlot(part.slot) && !isCleared(part)),
			Option.match({ onNone: () => text, onSome: (part) => stubOf([part]) }),
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

const guardedMessage = (message: Message, checked: readonly Checked[]): Message => {
	if (message.role === "system") {
		return guardedSystem(message, checked);
	}

	if (pipe(checked, Array.every(isCleared))) {
		return message;
	}

	return stubbedMessage(stubOf(checked))(message);
};

const guard = Effect.fn("guard")(function* guard<Failure>({
	messages,
	lookup,
	harness,
	keep,
}: {
	readonly messages: readonly Message[];
	readonly lookup: Lookup;
	readonly harness: Harness;
	readonly keep: Keep<Failure>;
}): Effect.fn.Return<readonly Message[], ToolsNotCleared | Failure, Digest.Digest> {
	const read = yield* Effect.forEach(
		messages,
		(message) => Effect.map(unitsOf(message), (units) => ({ message, units })),
		{ concurrency: 1 },
	);

	const units = pipe(
		read,
		Array.flatMap((each) => each.units),
	);

	const toolsUncleared = pipe(
		units,
		Array.some((unit) => Predicate.isTagged(unit.slot, "SystemTools") && lookup(unit.key) !== "cleared"),
	);

	if (toolsUncleared) {
		return yield* ToolsNotCleared.make({});
	}

	const handles = yield* keep(
		pipe(
			units,
			Array.filter((unit) => lookup(unit.key) === "sealed"),
			Array.map((unit) => ({ images: unit.images.length, key: unit.key, text: Array.join(unit.texts, "\n") })),
		),
	);

	return pipe(
		read,
		Array.map(({ message, units: parts }) =>
			guardedMessage(
				message,
				pipe(
					parts,
					Array.map(({ key, slot }): Checked => ({
						slot,
						standing: lookup(key),
						stub: Option.match(Option.fromUndefinedOr(handles.get(key)), {
							onNone: () => policyStubs.unknown,
							onSome: (handle) => sealedStub(harness)(handle),
						}),
					})),
				),
			),
		),
	);
});

export { ToolsNotCleared, guard, stubbedCalls, stubbedMessage };

export type { Keep };
