import { Array, Effect, Option, Order, Predicate, Schema, String as Str, Struct, pipe } from "effect";
import { BodyJson, LooseCall, LooseResult } from "./wire.ts";
import type { WireAssistantBlock, WireUnreadable, WireUserBlock } from "./wire.ts";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import type { Message } from "#router/features/parts/index.ts";
import { requests as captured } from "./captures/index.ts";
import { decodeRequest } from "./index.ts";

const requests = Struct.pick(captured, ["compaction", "firstTurn", "subagent", "toolResult"]);

const sealedStub =
	"[withheld: holds patient identifiers, handled on the HIPAA account] The next assistant reply was written there with this content in view, so what it says about this content is accurate. Work that needs the identifiers themselves goes to the phi-router:phi-sealed subagent.";

const stubText = { text: sealedStub, type: "text" } as const;

const piecesAroundNone = 1;

const nobodyWrote = (): boolean => false;

const decodeBody = Schema.decodeEffect(BodyJson);

const stubbed = (message: Message): Message => {
	switch (message.role) {
		case "system": {
			return { content: sealedStub, role: "system", sections: message.sections, tools: message.tools };
		}

		case "user": {
			return { content: [stubText], role: "user" };
		}

		case "toolResult": {
			return { content: [stubText], isError: message.isError, role: "toolResult", toolCallId: message.toolCallId };
		}

		case "assistant": {
			const calls = pipe(
				message.content,
				Array.flatMap((block) => {
					if (block.type === "toolCall") {
						return [{ arguments: "{}", id: block.id, name: block.name, type: "toolCall" } as const];
					}

					return [];
				}),
			);

			return { content: [stubText, ...calls], role: "assistant", writtenBy: message.writtenBy };
		}

		default: {
			const unhandled: never = message;

			return unhandled;
		}
	}
};

type SystemMessage = Extract<Message, { readonly role: "system" }>;

interface Guarded {
	readonly messages: readonly Message[];
	readonly stubs: number;
}

const pickedBy =
	(mask: readonly boolean[]) =>
	(index: number): boolean =>
		Array.isReadonlyArrayNonEmpty(mask) &&
		pipe(
			Array.get(mask, index % mask.length),
			Option.getOrElse(() => false),
		);

const sealedAfter = (head: SystemMessage, rest: readonly Message[], picked: (index: number) => boolean): Guarded => {
	const sections = pipe(
		head.sections,
		Array.map((section, index) => {
			if (picked(index)) {
				return { name: section.name, text: sealedStub };
			}

			return section;
		}),
	);

	const later = pipe(
		rest,
		Array.map((message, index) => {
			if (picked(head.sections.length + index)) {
				return stubbed(message);
			}

			return message;
		}),
	);

	const units = head.sections.length + rest.length;
	const stubs = pipe(Array.makeBy(units, picked), Array.filter(Boolean)).length;

	return { messages: [{ content: head.content, role: "system", sections, tools: head.tools }, ...later], stubs };
};

const sealedIn = (messages: readonly Message[], picked: (index: number) => boolean): Guarded =>
	pipe(
		messages,
		Array.matchLeft({
			onEmpty: () => ({ messages, stubs: 0 }),
			onNonEmpty: (head, rest) => {
				if (head.role === "system") {
					return sealedAfter(head, rest, picked);
				}

				return { messages, stubs: 0 };
			},
		}),
	);

const toolBlockStart = /(?=\{"type":"tool_use",|\{"tool_use_id":)/u;

const blockAt = 1;

const withVendorKeys = (body: string, picked: (index: number) => boolean): string =>
	pipe(
		Str.split(body, toolBlockStart),
		Array.map((piece, index) => {
			if (index < blockAt || !picked(index - blockAt)) {
				return piece;
			}

			return `{"new_vendor_field":"x",${Str.slice(blockAt)(piece)}`;
		}),
		Array.join(""),
	);

const isLooseCall = Schema.is(LooseCall);

const isLooseResult = Schema.is(LooseResult);

interface ToolIds {
	readonly calls: readonly string[];
	readonly results: readonly string[];
}

const looseIdsOf = (raw: WireUnreadable["unreadable"]): ToolIds => {
	if (isLooseCall(raw)) {
		return { calls: [raw.id], results: [] };
	}

	if (isLooseResult(raw)) {
		return { calls: [], results: [raw.tool_use_id] };
	}

	return { calls: [], results: [] };
};

const idsOf = (block: WireUserBlock | WireAssistantBlock): ToolIds => {
	if (block.type === "tool_use") {
		return { calls: [block.id], results: [] };
	}

	if (block.type === "tool_result") {
		return { calls: [], results: [block.tool_use_id] };
	}

	if (block.type === "unreadable") {
		return looseIdsOf(block.unreadable);
	}

	return { calls: [], results: [] };
};

const pairedIn = Effect.fnUntraced(function* pairedIn(body: string, label: string) {
	const { messages } = yield* decodeBody(body, { onExcessProperty: "error" });

	const blocks = pipe(
		messages,
		Array.flatMap((turn) => {
			if (!("role" in turn) || turn.role === "system" || Predicate.isString(turn.content)) {
				return [];
			}

			return turn.content;
		}),
		Array.map(idsOf),
	);

	const calls = pipe(
		blocks,
		Array.flatMap((ids) => ids.calls),
		Array.sortBy(Order.String),
	);

	const results = pipe(
		blocks,
		Array.flatMap((ids) => ids.results),
		Array.sortBy(Order.String),
	);

	assert.deepStrictEqual(results, calls, `${label}: each call has one result`);
	assert.lengthOf(Array.dedupe(calls), calls.length, `${label}: each id is one call`);

	return calls;
});

const bridgeSections = 1;

const withoutBridge = (messages: readonly Message[]): readonly Message[] =>
	pipe(
		messages,
		Array.matchLeft({
			onEmpty: () => messages,
			onNonEmpty: (head, rest) => {
				if (head.role !== "system") {
					return messages;
				}

				const sections = Array.dropRight(head.sections, bridgeSections);

				return [{ content: head.content, role: "system", sections, tools: head.tools }, ...rest];
			},
		}),
	);

const pairingHolds = Effect.fnUntraced(function* pairingHolds(name: string, body: string, sent: readonly string[]) {
	const ids = yield* pairedIn(body, `${name} as sent`);
	const lanes = yield* Effect.forEach(sent, (lane) => pairedIn(lane, `${name} upstream`), { concurrency: 1 });

	for (const lane of lanes) {
		assert.deepStrictEqual(lane, ids, `${name}: each call keeps its id`);
	}
});

const stubsStayValid = Effect.fnUntraced(function* stubsStayValid(
	name: keyof typeof requests,
	mask: readonly boolean[],
	vendor: readonly boolean[],
) {
	const body = withVendorKeys(requests[name], pickedBy(vendor));
	const request = yield* decodeRequest(body, nobodyWrote, "claude");
	const guarded = sealedIn(request.messages, pickedBy(mask));
	const toOpen = yield* request.encode({ lane: "clean", messages: guarded.messages, upstreamModel: "claude-target" });
	const toBaa = yield* request.encode({ lane: "sealed", pinned: false, upstreamModel: "claude-target" });

	yield* pairingHolds(name, body, [toOpen, toBaa]);

	const back = yield* decodeRequest(toOpen, nobodyWrote, "claude");

	assert.lengthOf(
		Str.split(toOpen, sealedStub),
		guarded.stubs + piecesAroundNone,
		`${name}: one stub per stubbed part`,
	);
	assert.deepStrictEqual(
		withoutBridge(back.messages),
		guarded.messages,
		`${name}: an open account reads what the border returned`,
	);
});

it.layer(Digest.layerWebCrypto)("a stub rewrite", (test) => {
	test.effect.prop(
		"keeps each tool call beside one result under its id, and sends exactly what the border returned",
		{
			mask: Schema.Array(Schema.Boolean),
			name: Schema.Literals(["compaction", "firstTurn", "subagent", "toolResult"]),
			vendor: Schema.Array(Schema.Boolean),
		},
		({ mask, name, vendor }) => stubsStayValid(name, mask, vendor),
	);
});
