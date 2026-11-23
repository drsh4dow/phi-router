import { Array, Effect, Option, Predicate, pipe } from "effect";
import type { Located, Span } from "./spans.ts";
import { itemsOf, kept, locate, required, textOf, valueOf } from "./spans.ts";
import type { Message } from "#router/features/parts/index.ts";
import type { WireBody } from "./wire.ts";
import { stubs } from "#router/features/policy/index.ts";

type SystemMessage = Extract<Message, { readonly role: "system" }>;

type SystemBlock = NonNullable<WireBody["system"]>[number];

type WireTool = NonNullable<WireBody["tools"]>[number];

/**
 * Claude Code's attribution block, in the pairs and values Claude Code 2.1.325 was recorded sending, so no session
 * content can hide in it. Only a first system block that is plain text and matches stays out of the sections. Any other
 * first block is a section and is judged.
 */
const attribution =
	/^x-anthropic-billing-header: cc_version=2\.1\.\d{1,3}\.[\da-f]{3}; cc_entrypoint=(?:cli|sdk-cli);(?: cc_is_subagent=true;)?$/u;

/** A `system` block after the attribution block: its engine section beside its wire. */
interface Section {
	readonly name: string;
	readonly text: string;
	readonly readable: boolean;
	readonly span: Span;
	/** The block's `cache_control` member, which a rewrite keeps. */
	readonly kept: readonly string[];
}

/** Where the bridge goes: the text between `start` and `end` becomes `before`, the bridge block, then `after`. */
interface BridgeSlot {
	readonly start: number;
	readonly end: number;
	readonly before: string;
	readonly after: string;
}

/** The body's `system` blocks and `tools`, the first engine message. */
interface SystemRun {
	readonly message: SystemMessage;
	readonly sections: readonly Section[];
	readonly bridge: BridgeSlot;
}

const afterLastMember = (body: Span): BridgeSlot => {
	const end = pipe(
		Array.last(body.members),
		Option.match({ onNone: () => body.start, onSome: (member) => member.value.end }),
	);

	return { after: "]", before: ',"system":[', end, start: end };
};

/**
 * The bridge closes the `system` array, or opens one after the body's last member when the body has none.
 *
 * @param {Span} body The body.
 * @returns {BridgeSlot} Where the bridge goes.
 */
const bridgeSlot = (body: Span): BridgeSlot =>
	pipe(
		valueOf("system")(body),
		Option.match({
			onNone: () => afterLastMember(body),
			onSome: (blocks) =>
				pipe(
					Array.last(blocks.items),
					Option.match({
						onNone: () => ({ after: "]", before: "[", end: blocks.end, start: blocks.start }),
						onSome: (last) => ({ after: "", before: ",", end: last.end, start: last.end }),
					}),
				),
		}),
	);

const sectionOf = ({ span, wire }: Located<SystemBlock>, index: number): Section => {
	const name = String(index);

	if (wire.type === "unreadable") {
		return { kept: kept(span), name, readable: false, span, text: stubs.unknown };
	}

	return { kept: kept(span), name, readable: true, span, text: wire.text };
};

const isAttribution = (section: Section): boolean => section.readable && attribution.test(section.text);

/** A tool as the engine reads it. Tools are never rewritten, so a tool the codec cannot read is judged on every byte. */
const toolOf = Effect.fnUntraced(function* toolOf({
	span,
	wire,
}: Located<WireTool>): Effect.fn.Return<SystemMessage["tools"][number]> {
	if ("unreadable" in wire) {
		const { name } = wire.unreadable;

		if (Predicate.isString(name)) {
			return { description: "", name, parameters: textOf(span) };
		}

		return { description: "", name: "", parameters: textOf(span) };
	}

	const schema = yield* required(span, "input_schema");

	return { description: wire.description, name: wire.name, parameters: textOf(schema) };
});

/**
 * Top-level fields judged whole with the tools, as entries after them: their every byte is in the tool-list part, and
 * guard refuses the clean lane while that part is not cleared. Nothing edits them, so they leave as sent.
 *
 * @param {Span} body The body.
 * @returns {readonly SystemMessage["tools"][number][]} One entry per field present.
 */
const judgedWhole = (body: Span): readonly SystemMessage["tools"][number][] => {
	const format = pipe(valueOf("output_config")(body), Option.flatMap(valueOf("format")));

	const fields = [
		["safeguards", valueOf("safeguards")(body)],
		["output_config.format", format],
	] as const;

	return pipe(
		fields,
		Array.flatMap(([name, value]) =>
			Option.match(value, {
				onNone: () => [],
				onSome: (span) => [{ description: "", name, parameters: textOf(span) }],
			}),
		),
	);
};

/** The attribution block is no section. A section's name is its index among the `system` blocks. */
const systemOf = Effect.fnUntraced(function* systemOf(wire: WireBody, body: Span): Effect.fn.Return<SystemRun> {
	const all = pipe(wire.system ?? [], locate(itemsOf("system")(body)), Array.map(sectionOf));

	const sections = Array.matchLeft(all, {
		onEmpty: () => all,
		onNonEmpty: (first, rest) => {
			if (isAttribution(first)) {
				return rest;
			}

			return all;
		},
	});

	const located = pipe(wire.tools ?? [], locate(itemsOf("tools")(body)));
	const tools = yield* Effect.forEach(located, toolOf, { concurrency: 1 });

	const message = {
		content: "",
		role: "system",
		sections: pipe(
			sections,
			Array.map(({ name, text }) => ({ name, text })),
		),
		tools: [...tools, ...judgedWhole(body)],
	} as const;

	return { bridge: bridgeSlot(body), message, sections };
});

export { systemOf };

export type { SystemRun };
