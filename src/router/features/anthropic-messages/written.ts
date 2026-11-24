import { Array, Effect, Equal, Option, Predicate, Schema, pipe } from "effect";
import type { AssistantMessage, Message } from "#router/features/parts/index.ts";
import type { Run, Spelling, Turn, WireCall } from "./runs.ts";
import type { Edit } from "./spans.ts";
import { JsonString } from "./wire.ts";

type UserMessage = Extract<Message, { readonly role: "user" }>;

type EngineBlock = UserMessage["content"][number];

type Reply = Extract<Run, { readonly kind: "reply" }>;

const misaligned = Effect.die("the border's messages do not line up with the request's");

const quoted = Effect.fnUntraced(function* quoted(text: string): Effect.fn.Return<string> {
	return yield* Effect.orDie(Schema.encodeEffect(JsonString)(text));
});

const after = (members: readonly string[]): string =>
	pipe(
		members,
		Array.map((member) => `,${member}`),
		Array.join(""),
	);

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
	if (turn.replaces === "content") {
		const whole = yield* wholeContent(pairs);

		if (Option.isSome(whole)) {
			return whole.value;
		}
	}

	const blocks = yield* Effect.forEach(pairs, ([run, guarded]) => blocksOf(run, guarded), { concurrency: 1 });
	const content = `[${pipe(blocks, Array.flatten, Array.join(","))}]`;

	if (turn.replaces === "content") {
		return content;
	}

	const role = yield* quoted(turn.role);

	return `{"role":${role},"content":${content}${after(turn.kept)}}`;
});

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
