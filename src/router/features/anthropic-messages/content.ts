import { Array, Effect, Option, Predicate, Schema, pipe } from "effect";
import type { Located, Span } from "./spans.ts";
import type { Run, Spelling } from "./runs.ts";
import type { WireImage, WireText, WireToolReference, WireToolResult, WireUnreadable, WireUserBlock } from "./wire.ts";
import { kept, locate, required, textOf } from "./spans.ts";
import { LooseResult } from "./wire.ts";
import type { Message } from "#router/features/parts/index.ts";
import { withheld } from "./reply.ts";

type UserMessage = Extract<Message, { readonly role: "user" }>;

type EngineBlock = UserMessage["content"][number];

type ContentBlock = WireText | WireImage | WireToolReference | WireUnreadable;

type PromptBlock = Exclude<WireUserBlock, WireToolResult>;

interface Reading {
	readonly content: readonly EngineBlock[];
	readonly readable: boolean;
}

type UserBlock =
	| { readonly kind: "result"; readonly run: Run }
	| { readonly kind: "prompt"; readonly block: Located<PromptBlock> };

const isLooseResult = Schema.is(LooseResult);

const blocksSpelled = (spans: readonly Span[]): Spelling => ({
	kept: pipe(
		Array.last(spans),
		Option.map(kept),
		Option.getOrElse(() => []),
	),
	kind: "blocks",
});

const spellingOf = ({ span, wire }: Located<string | readonly ContentBlock[]>): Spelling => {
	if (Predicate.isString(wire)) {
		return { kind: "string" };
	}

	return blocksSpelled(span.items);
};

const engineOf = (block: Exclude<ContentBlock, WireUnreadable>): EngineBlock => {
	switch (block.type) {
		case "text": {
			return { text: block.text, type: "text" };
		}

		case "image": {
			return { data: block.source.data, mimeType: block.source.media_type, type: "image" };
		}

		case "tool_reference": {
			return { text: `tool_reference: ${block.tool_name}`, type: "text" };
		}

		default: {
			const unhandled: never = block;

			return unhandled;
		}
	}
};

const readingOf = (content: string | readonly ContentBlock[]): Reading => {
	if (Predicate.isString(content)) {
		return { content: [{ text: content, type: "text" }], readable: true };
	}

	const known = pipe(
		content,
		Array.flatMap((block) => {
			if (block.type === "unreadable") {
				return [];
			}

			return [engineOf(block)];
		}),
	);

	if (known.length === content.length) {
		return { content: known, readable: true };
	}

	return { content: [withheld], readable: false };
};

const promptRun = (blocks: readonly Located<PromptBlock>[]): Run => {
	const spans = pipe(
		blocks,
		Array.map(({ span }) => span),
	);

	const reading = readingOf(
		pipe(
			blocks,
			Array.map(({ wire }) => wire),
		),
	);

	return {
		blocks: pipe(spans, Array.map(textOf)),
		content: blocksSpelled(spans),
		kind: "prompt",
		message: { content: reading.content, role: "user" },
		readable: reading.readable,
	};
};

const resultRun = Effect.fnUntraced(function* resultRun({
	span,
	wire,
}: Located<WireToolResult>): Effect.fn.Return<Run> {
	const reading = readingOf(wire.content);
	const inner = yield* required(span, "content");

	const message = {
		content: reading.content,
		isError: wire.is_error ?? false,
		role: "toolResult",
		toolCallId: wire.tool_use_id,
	} as const;

	return {
		blocks: [textOf(span)],
		content: spellingOf({ span: inner, wire: wire.content }),
		kept: kept(span),
		kind: "result",
		message,
		readable: reading.readable,
	};
});

const unreadableResult = ({ span, wire }: Located<WireUnreadable["unreadable"]>): Option.Option<Run> => {
	if (!isLooseResult(wire)) {
		return Option.none();
	}

	const message = {
		content: [withheld],
		isError: wire["is_error"] === true,
		role: "toolResult",
		toolCallId: wire.tool_use_id,
	} as const;

	return Option.some({
		blocks: [],
		content: { kept: [], kind: "blocks" },
		kept: kept(span),
		kind: "result",
		message,
		readable: false,
	});
};

const userBlockOf = Effect.fnUntraced(function* userBlockOf({
	span,
	wire,
}: Located<WireUserBlock>): Effect.fn.Return<UserBlock> {
	if (wire.type === "tool_result") {
		const run = yield* resultRun({ span, wire });

		return { kind: "result", run };
	}

	if (wire.type === "unreadable") {
		const loose = unreadableResult({ span, wire: wire.unreadable });

		if (Option.isSome(loose)) {
			return { kind: "result", run: loose.value };
		}
	}

	return { block: { span, wire }, kind: "prompt" };
});

const promptOf = (block: UserBlock): readonly Located<PromptBlock>[] => {
	if (block.kind === "prompt") {
		return [block.block];
	}

	return [];
};

const groupRun = (group: Array.NonEmptyReadonlyArray<UserBlock>): Run => {
	const first = Array.headNonEmpty(group);

	if (first.kind === "result") {
		return first.run;
	}

	return promptRun(pipe(group, Array.flatMap(promptOf)));
};

const userRuns = Effect.fnUntraced(function* userRuns({
	span,
	wire,
}: Located<string | readonly WireUserBlock[]>): Effect.fn.Return<readonly Run[]> {
	if (Predicate.isString(wire)) {
		const message = { content: readingOf(wire).content, role: "user" } as const;

		return [{ blocks: [], content: { kind: "string" }, kind: "prompt", message, readable: true }];
	}

	const blocks = yield* Effect.forEach(pipe(wire, locate(span.items)), userBlockOf, { concurrency: 1 });

	return Array.match(blocks, {
		onEmpty: () => [promptRun([])],
		onNonEmpty: (all) =>
			pipe(
				all,
				Array.groupWith((one, other) => one.kind === "prompt" && other.kind === "prompt"),
				Array.map(groupRun),
			),
	});
});

/**
 * A harness note: its text blocks joined, as the engine's system message reads them.
 *
 * @param {Located<string | readonly ContentBlock[]>} content The note's wire content, and where it sits.
 * @returns {Run} The run.
 */
const noteRun = (content: Located<string | readonly ContentBlock[]>): Run => {
	const reading = readingOf(content.wire);

	const text = pipe(
		reading.content,
		Array.flatMap((block) => {
			if (block.type === "text") {
				return [block.text];
			}

			return [];
		}),
		Array.join("\n"),
	);

	return {
		blocks: pipe(content.span.items, Array.map(textOf)),
		content: spellingOf(content),
		kind: "note",
		message: { content: text, role: "system", sections: [], tools: [] },
		readable: reading.readable,
	};
};

export { noteRun, unreadableResult, userRuns };
