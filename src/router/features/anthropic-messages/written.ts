import { Array, Effect, Equal, Option, Predicate, Schema, pipe } from "effect";
import type { AssistantMessage, Message } from "#router/features/parts/index.ts";
import type { Run, Spelling, Turn, WireCall } from "./runs.ts";
import type { Edit } from "./spans.ts";
import { JsonString } from "./wire.ts";

type UserMessage = Extract<Message, { readonly role: "user" }>;

type EngineBlock = UserMessage["content"][number];

type Reply = Extract<Run, { readonly kind: "reply" }>;

const misaligned = Effect.die("the border's messages do not line up with the request's");

/** A string as JSON text, for each string the codec writes fresh. */
const quoted = Effect.fnUntraced(function* quoted(text: string): Effect.fn.Return<string> {
	return yield* Effect.orDie(Schema.encodeEffect(JsonString)(text));
});

const after = (members: readonly string[]): string =>
	pipe(
		members,
		Array.map((member) => `,${member}`),
		Array.join(""),
	);

/** One block written fresh, with the members of the wire block it replaces that a rewrite keeps. */
const freshBlock = Effect.fnUntraced(function* freshBlock(
	block: EngineBlock,
	kept: readonly string[],
): Effect.fn.Return<string> {
	if (block.type === "text") {
		const text = yield* quoted(block.text);

		return `{"type":"text","text":${text}${after(kept)}}`;
	}

	const mediaType = yield* quoted(block.mimeType);
	const data = yield* quoted(block.data);

	return `{"type":"image","source":{"type":"base64","media_type":${mediaType},"data":${data}}${after(kept)}}`;
});

/** Blocks written fresh, the last one keeping the cache breakpoint the wire's last block carried. */
const freshBlocks = Effect.fnUntraced(function* freshBlocks(
	blocks: readonly EngineBlock[],
	kept: readonly string[],
): Effect.fn.Return<readonly string[]> {
	if (!Array.isReadonlyArrayNonEmpty(blocks)) {
		return [];
	}

	const init = yield* Effect.forEach(Array.initNonEmpty(blocks), (block) => freshBlock(block, []), { concurrency: 1 });
	const last = yield* freshBlock(Array.lastNonEmpty(blocks), kept);

	return [...init, last];
});

const keptBy = (spelling: Spelling): readonly string[] => {
	if (spelling.kind === "string") {
		return [];
	}

	return spelling.kept;
};

/** A content written fresh: a string while the wire's was one and the rewrite is one text, else blocks. */
const contentText = Effect.fnUntraced(function* contentText(
	spelling: Spelling,
	blocks: readonly EngineBlock[],
): Effect.fn.Return<string> {
	const [first, ...rest] = blocks;

	if (
		spelling.kind === "string" &&
		Predicate.isNotUndefined(first) &&
		first.type === "text" &&
		Array.isReadonlyArrayEmpty(rest)
	) {
		return yield* quoted(first.text);
	}

	const fresh = yield* freshBlocks(blocks, keptBy(spelling));

	return `[${Array.join(fresh, ",")}]`;
});

/** What the border returned for a prompt or a note, as blocks. */
const engineBlocks = Effect.fnUntraced(function* engineBlocks(
	guarded: Message,
): Effect.fn.Return<readonly EngineBlock[]> {
	if (guarded.role === "user") {
		return guarded.content;
	}

	if (guarded.role === "system") {
		return [{ text: guarded.content, type: "text" }];
	}

	return yield* misaligned;
});

/** A wire tool call under its own id and name, with the border's arguments for that id, or none. */
const callText = Effect.fnUntraced(function* callText(
	call: WireCall,
	guarded: AssistantMessage,
): Effect.fn.Return<string> {
	const input = pipe(
		guarded.content,
		Array.findFirst((block) => {
			if (block.type === "toolCall" && block.id === call.id) {
				return Option.some(block.arguments);
			}

			return Option.none();
		}),
		Option.getOrElse(() => "{}"),
	);

	const id = yield* quoted(call.id);
	const name = yield* quoted(call.name);

	return `{"type":"tool_use","id":${id},"name":${name},"input":${input}${after(call.kept)}}`;
});

/** A changed reply: the border's text, the last keeping the wire's last cache breakpoint, then every wire tool call. */
const freshReply = Effect.fnUntraced(function* freshReply(
	run: Reply,
	guarded: Message,
): Effect.fn.Return<readonly string[]> {
	if (guarded.role !== "assistant") {
		return yield* misaligned;
	}

	const texts = pipe(
		guarded.content,
		Array.flatMap((block) => {
			if (block.type === "text") {
				return [block];
			}

			return [];
		}),
	);

	const written = yield* freshBlocks(texts, run.kept);
	const calls = yield* Effect.forEach(run.calls, (call) => callText(call, guarded), { concurrency: 1 });

	return [...written, ...calls];
});

/** A tool result under the wire's call id, keeping its `is_error` and `cache_control` members. */
const freshResult = Effect.fnUntraced(function* freshResult(
	run: Extract<Run, { readonly kind: "result" }>,
	guarded: Message,
): Effect.fn.Return<readonly string[]> {
	if (guarded.role !== "toolResult") {
		return yield* misaligned;
	}

	const id = yield* quoted(guarded.toolCallId);
	const content = yield* contentText(run.content, guarded.content);

	return [`{"tool_use_id":${id},"type":"tool_result","content":${content}${after(run.kept)}}`];
});

/** The blocks of a run the border changed, or that the codec cannot read, written from what the border returned. */
const freshRun = Effect.fnUntraced(function* freshRun(run: Run, guarded: Message): Effect.fn.Return<readonly string[]> {
	switch (run.kind) {
		case "prompt":
		case "note": {
			const blocks = yield* engineBlocks(guarded);

			return yield* freshBlocks(blocks, keptBy(run.content));
		}

		case "reply": {
			return yield* freshReply(run, guarded);
		}

		case "result": {
			return yield* freshResult(run, guarded);
		}

		default: {
			const unhandled: never = run;

			return unhandled;
		}
	}
});

const keeps = (run: Run, guarded: Message): boolean => run.readable && Equal.equals(guarded, run.message);

/**
 * Thinking an open account did not stream never reaches an open account. Each block it streamed stays, even after a
 * stub, whoever wrote the rest of the reply.
 *
 * @param {Run} run A run of the request.
 * @returns {boolean} Whether the run holds thinking to drop.
 */
const dropsThinking = (run: Run): boolean =>
	run.kind === "reply" &&
	pipe(
		run.thinking,
		Array.some((block) => !block.streamed),
	);

const blocksOf = Effect.fnUntraced(function* blocksOf(run: Run, guarded: Message): Effect.fn.Return<readonly string[]> {
	let visible = run.blocks;

	if (!keeps(run, guarded)) {
		visible = yield* freshRun(run, guarded);
	}

	if (run.kind === "reply") {
		const streamed = pipe(
			run.thinking,
			Array.filter((block) => block.streamed),
			Array.map((block) => block.source),
		);

		return [...streamed, ...visible];
	}

	return visible;
});

/** A message that is one prompt or one note, written as its whole content, so a string stays a string. */
const wholeContent = Effect.fnUntraced(function* wholeContent(
	pairs: readonly (readonly [Run, Message])[],
): Effect.fn.Return<Option.Option<string>> {
	const [only, ...others] = pairs;

	if (Predicate.isUndefined(only) || Array.isReadonlyArrayNonEmpty(others)) {
		return Option.none();
	}

	const [run, guarded] = only;

	if (run.kind !== "prompt" && run.kind !== "note") {
		return Option.none();
	}

	const blocks = yield* engineBlocks(guarded);
	const content = yield* contentText(run.content, blocks);

	return Option.some(content);
});

const turnText = Effect.fnUntraced(function* turnText(
	turn: Turn,
	pairs: readonly (readonly [Run, Message])[],
): Effect.fn.Return<string> {
	if (turn.rewrite === "content") {
		const whole = yield* wholeContent(pairs);

		if (Option.isSome(whole)) {
			return whole.value;
		}
	}

	const blocks = yield* Effect.forEach(pairs, ([run, guarded]) => blocksOf(run, guarded), { concurrency: 1 });
	const content = `[${pipe(blocks, Array.flatten, Array.join(","))}]`;

	if (turn.rewrite === "content") {
		return content;
	}

	const role = yield* quoted(turn.rewrite);

	return `{"role":${role},"content":${content}${after(turn.kept)}}`;
});

/**
 * One wire message as an open account receives it: no edit while the border returned each of its runs unchanged, else
 * its content rewritten. A message the codec cannot read is always rewritten whole, so its raw text never reaches an
 * open account.
 */
const turnEdit = Effect.fnUntraced(function* turnEdit(
	turn: Turn,
	guarded: readonly Message[],
): Effect.fn.Return<Option.Option<Edit>> {
	const pairs = Array.zip(turn.runs, guarded);

	const unchanged = pipe(
		pairs,
		Array.every(([run, message]) => keeps(run, message) && !dropsThinking(run)),
	);

	if (unchanged) {
		return Option.none();
	}

	const text = yield* turnText(turn, pairs);

	return Option.some({ end: turn.span.end, start: turn.span.start, text });
});

export { freshBlock, misaligned, quoted, turnEdit };
