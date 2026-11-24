import { Array, Effect, Option, Schema, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { BodyJson } from "./wire.ts";
import { Digest } from "effect/crypto";
import type { Message } from "#router/features/parts/index.ts";
import type { MessagesRequest } from "./index.ts";
import type { Target } from "#router/features/border/index.ts";
import type { WireBody } from "./wire.ts";
import { decodeRequest } from "./index.ts";
import { requests } from "./captures/index.ts";
import { stubs } from "#router/features/policy/index.ts";

const sealedStub =
	"[withheld: holds patient identifiers, handled on the HIPAA account] The next assistant reply was written there with this content in view, so what it says about this content is accurate. Work that needs the identifiers themselves goes to the phi-router:phi-sealed subagent.";

const prompted = String.raw`{"model":"phi/auto","messages":[{"role":"user","content":[{"type":"text","text":"Read notes.txt.","cache_control":{"type":"ephemeral"}}]},{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"notes.txt"}}]},{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"1\tsynthetic note"}]}],"max_tokens":1000}`;

const replied = String.raw`{"model":"phi/auto","messages":[{"role":"user","content":"Read notes.txt."},{"role":"assistant","content":[{"type":"text","text":"Reading it.","cache_control":{"type":"ephemeral"}},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"notes.txt"}}]},{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"1\tsynthetic note"}]}],"max_tokens":1000}`;

const withUnreadable = String.raw`{"model":"phi/auto","messages":[{"role":"user","content":[{"type":"text","text":"Summarize the file."},{"type":"document","source":{"type":"text","media_type":"text/plain","data":"PATIENT-SECRET"}}]},{"role":"assistant","content":[{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{"query":"PATIENT-SECRET"}},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"notes.txt"}}]},{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":[{"type":"text","text":"notes","citations":[{"cited_text":"PATIENT-SECRET"}]}]}]}],"max_tokens":1000}`;

const target = "claude-target";

const stubText = { text: sealedStub, type: "text" } as const;

const nobodyWrote = (): boolean => false;

const openWroteAll = (): boolean => true;

const decodeBody = Schema.decodeEffect(BodyJson);

const sent = Effect.fnUntraced(function* sent(request: MessagesRequest, upstream: Target) {
	const body = yield* request.encode(upstream);

	return yield* decodeBody(body, { onExcessProperty: "error" });
});

const clean = (messages: readonly Message[]): Target => ({ lane: "clean", messages, model: target });

const replies = (body: WireBody): readonly (readonly string[])[] =>
	pipe(
		body.messages,
		Array.flatMap((turn) => {
			if ("role" in turn && turn.role === "assistant") {
				return [
					pipe(
						turn.content,
						Array.map((block) => block.type),
					),
				];
			}

			return [];
		}),
	);

const stubbedWhere = (
	messages: readonly Message[],
	picked: (message: Message, index: number) => boolean,
): readonly Message[] =>
	pipe(
		messages,
		Array.map((message, index): Message => {
			if (!picked(message, index) || message.role === "system") {
				return message;
			}

			if (message.role === "toolResult") {
				return {
					content: [stubText],
					isError: message.isError,
					role: "toolResult",
					toolCallId: message.toolCallId,
				};
			}

			if (message.role === "user") {
				return { content: [stubText], role: "user" };
			}

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
		}),
	);

const baaThinking = Effect.gen(function* baaThinking() {
	const request = yield* decodeRequest(requests.toolResult, nobodyWrote, "claude");
	const toOpen = yield* sent(request, clean(request.messages));
	const toBaa = yield* sent(request, { lane: "sealed", model: target, pinned: false });

	assert.deepStrictEqual(replies(toOpen), [["text"], ["tool_use"]]);
	assert.deepStrictEqual(replies(toBaa), [
		["thinking", "text"],
		["thinking", "tool_use"],
	]);
});

const openThinking = Effect.gen(function* openThinking() {
	const request = yield* decodeRequest(requests.toolResult, openWroteAll, "claude");

	const lastReply = pipe(
		request.messages,
		Array.findLastIndex((message) => message.role === "assistant"),
	);

	const guarded = stubbedWhere(request.messages, (_message, index) => Option.contains(lastReply, index));
	const toOpen = yield* sent(request, clean(guarded));

	const echoed = pipe(
		toOpen.messages,
		Array.findLast((turn) => "role" in turn && turn.role === "assistant"),
	);

	assert.deepStrictEqual(
		echoed,
		Option.some({
			content: [
				{ signature: "signature-placeholder", thinking: "", type: "thinking" },
				stubText,
				{ id: "toolu_01QLmmERkcyuzj56mJxsGPcP", input: {}, name: "Read", type: "tool_use" },
			],
			role: "assistant",
		}),
	);
});

const stubKeepsMetadata = Effect.gen(function* stubKeepsMetadata() {
	const request = yield* decodeRequest(prompted, nobodyWrote, "claude");
	const guarded = stubbedWhere(request.messages, (message) => message.role !== "assistant");
	const toOpen = yield* sent(request, clean(guarded));

	assert.deepStrictEqual(toOpen.messages, [
		{ content: [{ cache_control: { type: "ephemeral" }, text: sealedStub, type: "text" }], role: "user" },
		{
			content: [{ id: "toolu_1", input: { file_path: "notes.txt" }, name: "Read", type: "tool_use" }],
			role: "assistant",
		},
		{ content: [{ content: sealedStub, tool_use_id: "toolu_1", type: "tool_result" }], role: "user" },
	]);
});

const replyStubKeepsCache = Effect.gen(function* replyStubKeepsCache() {
	const request = yield* decodeRequest(replied, nobodyWrote, "claude");
	const guarded = stubbedWhere(request.messages, (message) => message.role === "assistant");
	const toOpen = yield* sent(request, clean(guarded));
	const [, reply] = toOpen.messages;

	assert.deepStrictEqual(reply, {
		content: [
			{ cache_control: { type: "ephemeral" }, text: sealedStub, type: "text" },
			{ id: "toolu_1", input: {}, name: "Read", type: "tool_use" },
		],
		role: "assistant",
	});
});

const unreadableWithheld = Effect.gen(function* unreadableWithheld() {
	const request = yield* decodeRequest(withUnreadable, nobodyWrote, "claude");
	const toOpen = yield* request.encode(clean(request.messages));
	const toBaa = yield* request.encode({ lane: "sealed", model: target, pinned: false });
	const received = yield* decodeBody(toOpen);
	const original = yield* decodeBody(withUnreadable);
	const kept = yield* decodeBody(toBaa);
	const unknownStub = { text: stubs.unknown, type: "text" } as const;

	assert.deepStrictEqual(received.messages, [
		{ content: [unknownStub], role: "user" },
		{ content: [unknownStub, { id: "toolu_1", input: {}, name: "Read", type: "tool_use" }], role: "assistant" },
		{ content: [{ content: [unknownStub], tool_use_id: "toolu_1", type: "tool_result" }], role: "user" },
	]);
	assert.notInclude(toOpen, "PATIENT-SECRET");
	assert.deepStrictEqual(kept.messages, original.messages);
});

it.layer(Digest.layerWebCrypto)("the rewrite rules", (test) => {
	test.effect(
		"thinking the BAA account wrote is dropped on the clean lane and kept on the sealed lane",
		() => baaThinking,
	);

	test.effect("thinking an open account wrote stays, even after its message is stubbed", () => openThinking);

	test.effect("a stub keeps a user prompt's cache_control and a tool result's tool_use_id", () => stubKeepsMetadata);

	test.effect("a stubbed reply keeps its last text block's cache_control", () => replyStubKeepsCache);

	test.effect(
		"a block the codec cannot name reaches an open account as the unknown stub, even when every part cleared",
		() => unreadableWithheld,
	);
});
