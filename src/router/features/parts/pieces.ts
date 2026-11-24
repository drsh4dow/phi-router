import { Array, Effect, Option, String as Str, pipe } from "effect";
import type { Message, SystemMessage } from "./message.ts";
import type { Piece, PieceKind, Seam } from "#router/features/policy/index.ts";
import { window as policyWindow, seamChars, stubs } from "#router/features/policy/index.ts";
import { textsOf, unitsOf } from "./parts.ts";
import type { ContentKey } from "#router/primitives/content-key.ts";
import type { Digest } from "effect/crypto";

const kinds = { system: "system", toolResult: "tool-result", user: "user" } as const;

const replyKinds = { "open-account": "reply-open", other: "reply-other" } as const;

const kindOf = (message: Message): PieceKind => {
	if (message.role === "assistant") {
		return replyKinds[message.writtenBy];
	}

	return kinds[message.role];
};

const labels = { assistant: "assistant", toolResult: "tool result", user: "user" } as const;

type Item = Exclude<Message, SystemMessage>;

const textOf = (message: Item): string => pipe(textsOf(message.content), Array.join("\n"));

const itemOf = (message: Item): string => `[${labels[message.role]}] ${textOf(message)}`;

const callsOf = (message: Item): readonly (readonly [string, string])[] => {
	if (message.role !== "assistant") {
		return [];
	}

	return pipe(
		message.content,
		Array.flatMap((block) => {
			if (block.type === "toolCall") {
				return [[block.id, `[tool call] ${Array.join(textsOf([block]), "")}`] as const];
			}

			return [];
		}),
	);
};

interface Reading {
	readonly text: string;
	readonly item: string;
	readonly calls: readonly (readonly [string, string])[];
}

const readingOf = (message: Item, sealed: boolean): Reading => {
	if (sealed) {
		return {
			calls: pipe(
				callsOf(message),
				Array.map(([id]) => [id, `[tool call] ${stubs.sealed}`] as const),
			),
			item: `[${labels[message.role]}] ${stubs.sealed}`,
			text: "",
		};
	}

	return { calls: callsOf(message), item: itemOf(message), text: textOf(message) };
};

const endsMidWord = /[\p{L}\p{N}]$/u;

const startsAtOnce = /^\S/u;

const seamAfter = (previous: string, text: string): Seam => {
	if (endsMidWord.test(previous) && startsAtOnce.test(text)) {
		return Str.takeRight(previous, seamChars);
	}

	return "";
};

interface ContextReader {
	readonly contextOf: (message: Message) => readonly string[];
	readonly seamOf: (message: Message) => Seam;
	readonly remember: (read: { readonly message: Message; readonly sealed: boolean }) => void;
}

/**
 * Remembers the items and tool calls read so far, a sealed one as its stub, and gives the next message its context. A
 * user message or tool result that starts right where the previous one of its role stopped mid-word, as an output cut
 * at a limit and fetched again does, gets that one's end as its seam, so an identifier cut in two is judged whole.
 *
 * @param {number} window How many preceding items a context holds at most.
 * @returns {ContextReader} The reader of one request's messages, in order.
 */
const contextReader = (window: number): ContextReader => {
	const calls = new Map<string, string>();
	const items: string[] = [];
	const lastText = new Map<Message["role"], string>();

	const seamOf = (message: Message): Seam => {
		if (message.role === "system") {
			return "";
		}

		return seamAfter(lastText.get(message.role) ?? "", textOf(message));
	};

	const ownCallOf = (message: Item): readonly string[] => {
		if (message.role !== "toolResult") {
			return [];
		}

		return Option.toArray(Option.fromUndefinedOr(calls.get(message.toolCallId)));
	};

	const contextOf = (message: Message): readonly string[] => {
		if (message.role === "system") {
			return [];
		}

		return Array.take([...ownCallOf(message), ...Array.reverse(Array.takeRight(items, window))], window);
	};

	const remember = ({ message, sealed }: { readonly message: Message; readonly sealed: boolean }): void => {
		if (message.role === "system") {
			return;
		}

		const reading = readingOf(message, sealed);

		lastText.set(message.role, reading.text);
		items.push(reading.item);

		for (const [id, call] of reading.calls) {
			calls.set(id, call);
		}
	};

	return { contextOf, remember, seamOf };
};

interface PieceAt {
	readonly piece: Piece<typeof ContentKey.Type>;
	/** In the request's own new content: the last assistant message and everything after it. */
	readonly own: boolean;
}

const piecesOf = Effect.fnUntraced(function* piecesOf({
	messages,
	window = policyWindow,
	sealed = () => false,
}: {
	readonly messages: readonly Message[];
	readonly window?: number;
	readonly sealed?: (key: typeof ContentKey.Type) => boolean;
}): Effect.fn.Return<readonly PieceAt[], never, Digest.Digest> {
	const lastReply = pipe(
		messages,
		Array.findLastIndex(({ role }) => role === "assistant"),
	);

	const reader = contextReader(window);
	const pieces: PieceAt[] = [];

	for (const [index, message] of messages.entries()) {
		const at = {
			context: reader.contextOf(message),
			kind: kindOf(message),
			own: Option.match(lastReply, { onNone: () => true, onSome: (from) => index >= from }),
			seam: reader.seamOf(message),
		};

		const units = yield* unitsOf(message);

		for (const { key, texts, images } of units) {
			pieces.push({ own: at.own, piece: { context: at.context, images, key, kind: at.kind, seam: at.seam, texts } });
		}

		reader.remember({
			message,
			sealed: pipe(
				units,
				Array.some(({ key }) => sealed(key)),
			),
		});
	}

	return pieces;
});

export { piecesOf };
