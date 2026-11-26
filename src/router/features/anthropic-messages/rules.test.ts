import { Array, Effect, Function, Option, Record, Schema, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { bridgesFor, stubbedMessage } from "#router/features/border/index.ts";
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
	"[sealed h1] This part held patient identifiers, so phi-router withheld it. When the task needs it read, redacted or its identifiers used, hand that segment of the work to the phi-router:phi-sealed subagent with a scoped task that names h1.";

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

const clean = (messages: readonly Message[]): Target => ({ lane: "clean", messages, upstreamModel: target });

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

			return stubbedMessage(sealedStub)(message);
		}),
	);

const baaThinking = Effect.gen(function* baaThinking() {
	const request = yield* decodeRequest(requests.toolResult, nobodyWrote, "claude");
	const toOpen = yield* sent(request, clean(request.messages));

	const toBaa = yield* sent(request, {
		added: [bridgesFor.claude],
		lane: "sealed",
		open: Function.identity,
		upstreamModel: target,
	});

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

	const toBaa = yield* request.encode({
		added: [bridgesFor.claude],
		lane: "sealed",
		open: Function.identity,
		upstreamModel: target,
	});

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

const forwardedMembers = String.raw`{"model":"phi/auto","messages":[{"role":"user","content":[{"type":"text","text":"Read notes.txt."},{"type":"text","text":"Then sum it up.","cache_control":{"type":"ephemeral"}}]},{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"notes.txt"},"caller":{"type":"direct"},"cache_control":{"type":"ephemeral"}}]},{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"1\tsynthetic note","is_error":true,"cache_control":{"type":"ephemeral"}}]}],"max_tokens":1000}`;

const stubKeepsForwarded = Effect.gen(function* stubKeepsForwarded() {
	const request = yield* decodeRequest(forwardedMembers, nobodyWrote, "claude");
	const toOpen = yield* sent(request, clean(stubbedWhere(request.messages, () => true)));
	const ephemeral = { type: "ephemeral" } as const;

	const call = {
		cache_control: ephemeral,
		caller: { type: "direct" },
		id: "toolu_1",
		input: {},
		name: "Read",
		type: "tool_use",
	} as const;

	const result = {
		cache_control: ephemeral,
		content: sealedStub,
		is_error: true,
		tool_use_id: "toolu_1",
		type: "tool_result",
	} as const;

	assert.deepStrictEqual(toOpen.messages, [
		{ content: [{ cache_control: ephemeral, text: sealedStub, type: "text" }], role: "user" },
		{ content: [stubText, call], role: "assistant" },
		{ content: [result], role: "user" },
	]);
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

	test.effect(
		"a stub keeps the cache_control of a prompt's last block, a tool call's caller and cache_control, and a tool result's is_error and cache_control",
		() => stubKeepsForwarded,
	);
});

const asked = '{"model":"phi/auto","messages":[{"role":"user","content":"Read notes.txt."}],"max_tokens":1000}';

const called = String.raw`{"model":"phi/auto","messages":[{"role":"user","content":"Read both files."},{"role":"assistant","content":[{"type":"text","text":"Reading both.","cache_control":{"type":"ephemeral"}},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"a.txt"}},{"type":"tool_use","id":"toolu_2","name":"Grep","input":{"pattern":"b"}}]},{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"a"},{"tool_use_id":"toolu_2","type":"tool_result","content":"b","is_error":true,"cache_control":{"type":"ephemeral"}}]}],"max_tokens":1000}`;

const vendorTurns = String.raw`{"model":"phi/auto","messages":[{"role":"user","content":"Read notes.txt."},{"role":"assistant","content":[{"type":"text","text":"PATIENT-SECRET"},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"notes.txt"}}],"new_vendor_field":"x"},{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"PATIENT-SECRET"},{"type":"text","text":"PATIENT-SECRET"}],"new_vendor_field":"x"},{"role":"developer","content":"PATIENT-SECRET"}],"max_tokens":1000}`;

const respelled = String.raw`{"model":"phi/auto","messages":[{"content":[{"text":"Read notes.txt.","type":"text"}],"role":"user"},{"role":"assistant","content":[ {"input":{"file_path":"notes.txt"},"name":"Read","id":"toolu_1","type":"tool_use"} ]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"note"}]}],"max_tokens":1000}`;

const unknownStubText = { text: stubs.unknown, type: "text" } as const;

const escapingText = 'Say "hi" \\ back,\n\ttab and bell \u0007 and line separator \u2028.';

const borderReturned = (messages: readonly Message[], returned: Message): readonly Message[] =>
	pipe(
		messages,
		Array.map((message) => {
			if (message.role === returned.role) {
				return returned;
			}

			return message;
		}),
	);

const unchangedAsSent = Effect.gen(function* unchangedAsSent() {
	for (const [name, body] of Record.toEntries(Record.set(requests, "respelled", respelled))) {
		const request = yield* decodeRequest(body, openWroteAll, "claude");
		const toOpen = yield* request.encode(clean(request.messages));

		const toBaa = yield* request.encode({
			added: [bridgesFor.claude],
			lane: "sealed",
			open: Function.identity,
			upstreamModel: target,
		});

		assert.strictEqual(toOpen, toBaa, name);
	}
});

const stringPromptRewritten = Effect.gen(function* stringPromptRewritten() {
	const request = yield* decodeRequest(asked, nobodyWrote, "claude");
	const guarded = borderReturned(request.messages, { content: [{ text: escapingText, type: "text" }], role: "user" });
	const toOpen = yield* sent(request, clean(guarded));

	assert.deepStrictEqual(toOpen.messages, [{ content: escapingText, role: "user" }]);
});

const promptSplit = Effect.gen(function* promptSplit() {
	const request = yield* decodeRequest(prompted, nobodyWrote, "claude");

	const guarded = borderReturned(request.messages, {
		content: [{ text: "Read it.", type: "text" }, stubText],
		role: "user",
	});

	const toOpen = yield* sent(request, clean(guarded));
	const [prompt] = toOpen.messages;

	assert.deepStrictEqual(prompt, {
		content: [
			{ text: "Read it.", type: "text" },
			{ cache_control: { type: "ephemeral" }, text: sealedStub, type: "text" },
		],
		role: "user",
	});
});

const replyCallsFromWire = Effect.gen(function* replyCallsFromWire() {
	const request = yield* decodeRequest(called, nobodyWrote, "claude");

	const guarded = borderReturned(request.messages, {
		content: [
			{ text: "Rewritten.", type: "text" },
			{ arguments: '{"file_path":"c.txt"}', id: "toolu_1", name: "Renamed", type: "toolCall" },
			{ arguments: "{}", id: "toolu_9", name: "Added", type: "toolCall" },
		],
		role: "assistant",
		writtenBy: "other",
	});

	const toOpen = yield* sent(request, clean(guarded));
	const [, reply] = toOpen.messages;

	assert.deepStrictEqual(reply, {
		content: [
			{ cache_control: { type: "ephemeral" }, text: "Rewritten.", type: "text" },
			{ id: "toolu_1", input: { file_path: "c.txt" }, name: "Read", type: "tool_use" },
			{ id: "toolu_2", input: {}, name: "Grep", type: "tool_use" },
		],
		role: "assistant",
	});
});

const unreadableTurnsWithheld = Effect.gen(function* unreadableTurnsWithheld() {
	const request = yield* decodeRequest(vendorTurns, nobodyWrote, "claude");
	const toOpen = yield* request.encode(clean(request.messages));
	const received = yield* decodeBody(toOpen, { onExcessProperty: "error" });

	assert.deepStrictEqual(received.messages, [
		{ content: "Read notes.txt.", role: "user" },
		{
			content: [unknownStubText, { id: "toolu_1", input: {}, name: "Read", type: "tool_use" }],
			role: "assistant",
		},
		{
			content: [{ content: [unknownStubText], tool_use_id: "toolu_1", type: "tool_result" }, unknownStubText],
			role: "user",
		},
		{ content: [unknownStubText], role: "user" },
	]);
	assert.notInclude(toOpen, "PATIENT-SECRET");
});

const unreadableReplyRead = Effect.gen(function* unreadableReplyRead() {
	const request = yield* decodeRequest(vendorTurns, nobodyWrote, "claude");

	const assistantMessages = pipe(
		request.messages,
		Array.filter((message) => message.role === "assistant"),
	);

	assert.deepStrictEqual(assistantMessages, [
		{
			content: [unknownStubText, { arguments: "{}", id: "toolu_1", name: "Read", type: "toolCall" }],
			role: "assistant",
			writtenBy: "other",
		},
	]);
});

it.layer(Digest.layerWebCrypto)("the rewrite of each message", (test) => {
	test.effect(
		"a message the border returned unchanged leaves for the clean lane byte for byte",
		() => unchangedAsSent,
	);

	test.effect(
		"a prompt sent as a string and rewritten to one text reaches the clean lane as that text, a string, whatever characters it holds",
		() => stringPromptRewritten,
	);

	test.effect("a prompt rewritten to several blocks keeps its cache_control on the last one only", () => promptSplit);

	test.effect(
		"a rewritten reply sends the border's text, then every wire tool call under its wire id and name with the border's arguments for that id, or none",
		() => replyCallsFromWire,
	);

	test.effect(
		"a message the codec cannot read reaches the clean lane whole as the unknown stub, its tool calls and results under their ids, and an unknown role as user",
		() => unreadableTurnsWithheld,
	);

	test.effect(
		"a reply the codec cannot read reads as the unknown stub, then each of its tool calls by id and name with no arguments",
		() => unreadableReplyRead,
	);
});
