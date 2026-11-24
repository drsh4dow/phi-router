import { Array, Effect, Option, Schema, Struct, pipe } from "effect";
import type { HoldsReplyKey, ReplyBlock } from "./reply.ts";
import type { Located, Span } from "./spans.ts";
import type { Run, Turn, WireCall } from "./runs.ts";
import type { WireAssistantBlock, WireBody, WireTurn, WireUnreadable } from "./wire.ts";
import { itemsOf, kept, locate, required, textOf } from "./spans.ts";
import { noteRun, unreadableResult, userRuns } from "./content.ts";
import { replyOf, withheld, withheldOf } from "./reply.ts";
import type { Digest } from "effect/crypto";
import { LooseCall } from "./wire.ts";
import type { SystemRun } from "./system.ts";
import { stubs } from "#router/features/policy/index.ts";
import { systemOf } from "./system.ts";

type Raw = WireUnreadable["unreadable"];

interface Decoded {
	readonly sentBody: string;
	readonly model: Span;
	readonly system: SystemRun;
	readonly turns: readonly Turn[];
}

const isLooseCall = Schema.is(LooseCall);

const isRaw = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const isList = Schema.is(Schema.Array(Schema.Unknown));

const unreadableNote: Run = {
	blocks: [],
	content: { kept: [], kind: "blocks" },
	kind: "note",
	message: { content: stubs.unknown, role: "system", sections: [], tools: [] },
	readable: false,
};

const unreadablePrompt: Run = {
	blocks: [],
	content: { kept: [], kind: "blocks" },
	kind: "prompt",
	message: { content: [withheld], role: "user" },
	readable: false,
};

const unreadableCall = ({ span, wire }: Located<Raw>): readonly WireCall[] => {
	if (!isLooseCall(wire)) {
		return [];
	}

	return [{ id: wire.id, kept: kept(span), name: wire.name }];
};

const callOf = ({ span, wire }: Located<WireAssistantBlock>): readonly WireCall[] => {
	if (wire.type === "unreadable") {
		return unreadableCall({ span, wire: wire.unreadable });
	}

	if (wire.type === "tool_use") {
		return [{ id: wire.id, kept: kept(span), name: wire.name }];
	}

	return [];
};

const replyBlockOf = ({ span, wire }: Located<WireAssistantBlock>): Effect.Effect<ReplyBlock> => {
	if (wire.type !== "tool_use") {
		return Effect.succeed(wire);
	}

	return Effect.map(required(span, "input"), (input) => Struct.assign(wire, { inputJson: textOf(input) }));
};

const isThinking = ({ wire }: Located<WireAssistantBlock>): boolean =>
	wire.type === "thinking" || wire.type === "redacted_thinking";

const replyRun = Effect.fnUntraced(function* replyRun(
	{ span, wire }: Located<readonly WireAssistantBlock[]>,
	openWrote: HoldsReplyKey,
): Effect.fn.Return<Run, never, Digest.Digest> {
	const blocks = pipe(wire, locate(span.items));
	const read = yield* Effect.forEach(blocks, replyBlockOf, { concurrency: 1 });
	const reply = yield* replyOf(read, openWrote);

	const visible = pipe(
		blocks,
		Array.filter((block) => !isThinking(block)),
		Array.map((block) => textOf(block.span)),
	);

	const thinking = pipe(
		blocks,
		Array.zip(reply.streamedOpenPerBlock),
		Array.filter(([block]) => isThinking(block)),
		Array.map(([block, streamed]) => ({ source: textOf(block.span), streamed })),
	);

	const lastText = pipe(
		blocks,
		Array.findLast((block) => block.wire.type === "text"),
	);

	return {
		blocks: visible,
		calls: pipe(blocks, Array.flatMap(callOf)),
		kept: Option.match(lastText, { onNone: () => [], onSome: (block) => kept(block.span) }),
		kind: "reply",
		message: { content: reply.content, role: "assistant", writtenBy: reply.writtenBy },
		readable: reply.readable,
		thinking,
	};
});

const rawBlocksOf = ({ span, wire }: Located<Raw>): readonly Located<Raw>[] => {
	const { content } = wire;

	if (!isList(content)) {
		return [];
	}

	return pipe(
		content,
		locate(itemsOf("content")(span)),
		Array.flatMap((block) => {
			if (isRaw(block.wire)) {
				return [{ span: block.span, wire: block.wire }];
			}

			return [];
		}),
	);
};

const withheldReply = (blocks: readonly Located<Raw>[]): Run => {
	const calls = pipe(blocks, Array.flatMap(unreadableCall));

	const read = pipe(
		calls,
		Array.map((call) => ({ arguments: "{}", id: call.id, name: call.name, type: "toolCall" }) as const),
	);

	return {
		blocks: [],
		calls,
		kept: [],
		kind: "reply",
		message: { content: withheldOf(read), role: "assistant", writtenBy: "other" },
		readable: false,
		thinking: [],
	};
};

const unreadableTurn = (message: Located<Raw>): Turn => {
	const blocks = rawBlocksOf(message);
	const { span } = message;

	if (message.wire["role"] === "assistant") {
		return { kept: kept(span), replaces: "message", role: "assistant", runs: [withheldReply(blocks)], span };
	}

	if (message.wire["role"] === "system") {
		return { kept: kept(span), replaces: "message", role: "system", runs: [unreadableNote], span };
	}

	const results = pipe(
		blocks,
		Array.flatMap((block) => Option.toArray(unreadableResult(block))),
	);

	return { kept: kept(span), replaces: "message", role: "user", runs: [...results, unreadablePrompt], span };
};

type ReadableTurn = Exclude<WireTurn, WireUnreadable>;

const runsOf = (
	content: Span,
	wire: ReadableTurn,
	openWrote: HoldsReplyKey,
): Effect.Effect<readonly Run[], never, Digest.Digest> => {
	switch (wire.role) {
		case "assistant": {
			return Effect.map(replyRun({ span: content, wire: wire.content }, openWrote), (run) => [run]);
		}

		case "system": {
			return Effect.succeed([noteRun({ span: content, wire: wire.content })]);
		}

		case "user": {
			return userRuns({ span: content, wire: wire.content });
		}

		default: {
			const unhandled: never = wire;

			return unhandled;
		}
	}
};

const turnOf = Effect.fnUntraced(function* turnOf(
	{ span, wire }: Located<WireTurn>,
	openWrote: HoldsReplyKey,
): Effect.fn.Return<Turn, never, Digest.Digest> {
	if ("unreadable" in wire) {
		return unreadableTurn({ span, wire: wire.unreadable });
	}

	const content = yield* required(span, "content");
	const runs = yield* runsOf(content, wire, openWrote);

	return { replaces: "content", runs, span: content };
});

const decodedOf = Effect.fnUntraced(function* decodedOf(
	wire: WireBody,
	body: Span,
	openWrote: HoldsReplyKey,
): Effect.fn.Return<Decoded, never, Digest.Digest> {
	const system = yield* systemOf(wire, body);
	const model = yield* required(body, "model");
	const messages = yield* required(body, "messages");

	const turns = yield* Effect.forEach(pipe(wire.messages, locate(messages.items)), (turn) => turnOf(turn, openWrote), {
		concurrency: 1,
	});

	return { model, sentBody: body.body, system, turns };
});

export { decodedOf };

export type { Decoded };
