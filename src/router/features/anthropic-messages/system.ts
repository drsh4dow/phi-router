import { Array, Effect, Option, Predicate, pipe } from "effect";
import type { Located, Span } from "./spans.ts";
import { itemsOf, kept, locate, required, textOf, valueOf } from "./spans.ts";
import type { Message } from "#router/features/parts/index.ts";
import type { WireBody } from "./wire.ts";
import { stubs } from "#router/features/policy/index.ts";

type SystemMessage = Extract<Message, { readonly role: "system" }>;

type SystemBlock = NonNullable<WireBody["system"]>[number];

type WireTool = NonNullable<WireBody["tools"]>[number];

const attribution =
	/^x-anthropic-billing-header: cc_version=2\.1\.\d{1,3}\.[\da-f]{3}; cc_entrypoint=(?:cli|sdk-cli);(?: cc_is_subagent=true;)?$/u;

interface LocatedSection {
	readonly name: string;
	readonly text: string;
	readonly readable: boolean;
	readonly span: Span;
	readonly kept: readonly string[];
}

interface BridgeSlot {
	readonly start: number;
	readonly end: number;
	readonly before: string;
	readonly after: string;
}

interface SystemRun {
	readonly message: SystemMessage;
	readonly sections: readonly LocatedSection[];
	readonly bridge: BridgeSlot;
}

const afterLastMember = (body: Span): BridgeSlot => {
	const end = pipe(
		Array.last(body.members),
		Option.match({ onNone: () => body.start, onSome: (member) => member.value.end }),
	);

	return { after: "]", before: ',"system":[', end, start: end };
};

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

const sectionOf = ({ span, wire }: Located<SystemBlock>, index: number): LocatedSection => {
	const name = String(index);

	if (wire.type === "unreadable") {
		return { kept: kept(span), name, readable: false, span, text: stubs.unknown };
	}

	return { kept: kept(span), name, readable: true, span, text: wire.text };
};

const isAttribution = (section: LocatedSection): boolean => section.readable && attribution.test(section.text);

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
