import { Array, Effect, Function, Schema, pipe } from "effect";
import { CleanLaneRefused, bridgesFor } from "#router/features/border/index.ts";
import { UnreadableRequest, decodeRequest, replyKeys } from "./index.ts";
import { assert, it } from "@effect/vitest";
import { BodyJson } from "./wire.ts";
import { Digest } from "effect/crypto";
import type { Message } from "#router/features/parts/index.ts";
import type { MessagesRequest } from "./index.ts";
import type { Target } from "#router/features/border/index.ts";
import { requests } from "./captures/index.ts";
import { stubs } from "#router/features/policy/index.ts";

const target = "claude-target";

const bridge = bridgesFor.claude;

const unknownStub = { text: stubs.unknown, type: "text" } as const;

const redacted = String.raw`{"model":"phi/auto","messages":[{"role":"user","content":"Plan it."},{"role":"assistant","content":[{"type":"redacted_thinking","data":"REDACTED-DATA"},{"type":"text","text":"Visible answer."}]},{"role":"user","content":"Go on."}],"max_tokens":1000}`;

const streamed = pipe(
	[
		'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[]}}',
		'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"REDACTED-DATA"}}',
		'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
		'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
		'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Visible answer."}}',
		'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
		'event: message_stop\ndata: {"type":"message_stop"}',
	],
	Array.join("\n\n"),
);

const vendorKeys = String.raw`{"model":"phi/auto","messages":[{"role":"user","content":"PATIENT-SECRET in a note.","new_vendor_field":"x"},{"role":"assistant","content":[{"type":"text","text":"Noted."}]},{"role":"user","content":"Go on."}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.325.a35; cc_entrypoint=cli;"},{"type":"text","text":"You are Claude Code. PATIENT-SECRET","new_vendor_field":"x","cache_control":{"type":"ephemeral"}}],"tools":[{"name":"Lookup","description":"Reads a row.","input_schema":{"type":"object"},"new_vendor_field":"x"}],"max_tokens":1000}`;

const tool = '{"name":"Lookup","description":"Reads a row.","input_schema":{"type":"object"},"new_vendor_field":"x"}';

const escapedRepeat = String.raw`{"model":"phi/auto","messages":[{"role":"user","content":"PATIENT-SECRET","cont\u0065nt":"Go on."}],"max_tokens":1000}`;

const nobodyWrote = (): boolean => false;

const strict = { onExcessProperty: "error" } as const;

const decodeBody = Schema.decodeEffect(BodyJson);

const clean = (request: MessagesRequest): Target => ({
	lane: "clean",
	messages: request.messages,
	upstreamModel: target,
});

const sealed: Target = { added: [bridgesFor.claude], lane: "sealed", open: Function.identity, upstreamModel: target };

const redactedFromBaa = Effect.gen(function* redactedFromBaa() {
	const request = yield* decodeRequest(redacted, nobodyWrote, "claude");
	const toOpen = yield* request.encode(clean(request));
	const received = yield* decodeBody(toOpen, strict);
	const [, reply] = received.messages;

	assert.deepStrictEqual(reply, { content: [unknownStub], role: "assistant" });
	assert.notInclude(toOpen, "REDACTED-DATA");
	assert.notInclude(toOpen, "Visible answer.");
});

const redactedFromOpen = Effect.gen(function* redactedFromOpen() {
	const keys = yield* replyKeys(streamed);
	const request = yield* decodeRequest(redacted, (key) => Array.contains(keys, key), "claude");
	const toOpen = yield* request.encode(clean(request));
	const received = yield* decodeBody(toOpen, strict);
	const original = yield* decodeBody(redacted, strict);

	assert.deepStrictEqual(received.messages, original.messages);
});

const systemOf = Effect.fnUntraced(function* systemOf(body: string) {
	const { system } = yield* decodeBody(body, strict);

	return system;
});

const vendorSystem = Effect.gen(function* vendorSystem() {
	const request = yield* decodeRequest(vendorKeys, nobodyWrote, "claude");
	const original = yield* systemOf(vendorKeys);
	const openBody = yield* request.encode(clean(request));
	const baaBody = yield* request.encode(sealed);
	const toOpen = yield* systemOf(openBody);
	const toBaa = yield* systemOf(baaBody);
	const bridgeBlock = { text: bridge, type: "text" } as const;

	assert.deepStrictEqual(toOpen, [
		{ text: "x-anthropic-billing-header: cc_version=2.1.325.a35; cc_entrypoint=cli;", type: "text" },
		{ cache_control: { type: "ephemeral" }, text: stubs.unknown, type: "text" },
		bridgeBlock,
	]);
	assert.deepStrictEqual(toBaa, [...(original ?? []), bridgeBlock]);
});

const vendorMessage = Effect.gen(function* vendorMessage() {
	const request = yield* decodeRequest(vendorKeys, nobodyWrote, "claude");
	const toOpen = yield* request.encode(clean(request));
	const received = yield* decodeBody(toOpen, strict);

	const expected: readonly Message[] = [
		{
			content: "",
			role: "system",
			sections: [{ name: "1", text: stubs.unknown }],
			tools: [{ description: "", name: "Lookup", parameters: tool }],
		},
		{ content: [unknownStub], role: "user" },
	];

	const [first] = received.messages;

	assert.deepStrictEqual(Array.take(request.messages, expected.length), expected);
	assert.deepStrictEqual(first, { content: [unknownStub], role: "user" });
	assert.notInclude(toOpen, "PATIENT-SECRET");
	assert.include(toOpen, tool);
});

const vendorPinned = Effect.gen(function* vendorPinned() {
	const request = yield* decodeRequest(vendorKeys, nobodyWrote, "claude");

	const sent = yield* request.encode({
		added: [],
		lane: "sealed",
		open: Function.identity,
		upstreamModel: request.model,
	});

	assert.strictEqual(sent, vendorKeys);
});

const repeatedKey = Effect.gen(function* repeatedKey() {
	const failure = yield* Effect.flip(decodeRequest(escapedRepeat, nobodyWrote, "claude"));

	assert.instanceOf(failure, UnreadableRequest);
	assert.include(failure.reason, '$["messages"][0]');
	assert.notInclude(failure.reason, "PATIENT-SECRET");
});

const strayCacheControl = String.raw`{"model":"phi/auto","messages":[{"role":"user","content":[{"type":"text","text":"Go on.","cache_control":{"type":"ephemeral","note":"PATIENT-SECRET"}}]}],"max_tokens":1000}`;

const refused = Effect.gen(function* refused() {
	const request = yield* decodeRequest(strayCacheControl, nobodyWrote, "claude");
	const failure = yield* Effect.flip(request.encode(clean(request)));

	const toBaa = yield* request.encode({
		added: [],
		lane: "sealed",
		open: Function.identity,
		upstreamModel: request.model,
	});

	assert.instanceOf(failure, CleanLaneRefused);
	assert.strictEqual(failure.reason, "messages[0].content[0].cache_control");
	assert.strictEqual(toBaa, strayCacheControl);
});

const toolReference = Effect.gen(function* toolReference() {
	const request = yield* decodeRequest(requests.toolSearch, nobodyWrote, "claude");

	const results = pipe(
		request.messages,
		Array.filter((message) => message.role === "toolResult"),
		Array.map((message) => message.content),
	);

	assert.deepStrictEqual(results, [[{ text: "tool_reference: NotebookEdit", type: "text" }]]);
});

const strayInUnreadable = String.raw`{"model":"phi/auto","messages":[{"role":"user","content":[{"type":"text","text":"Go on.","cache_control":{"type":"ephemeral","note":"PATIENT-SECRET"}}],"new_vendor_field":"x"}],"max_tokens":1000}`;

const refusedInUnreadable = Effect.gen(function* refusedInUnreadable() {
	const request = yield* decodeRequest(strayInUnreadable, nobodyWrote, "claude");
	const failure = yield* Effect.flip(request.encode(clean(request)));

	assert.instanceOf(failure, CleanLaneRefused);
	assert.strictEqual(failure.reason, "messages[0].content[0].cache_control");
});

const otherRedacted = String.raw`{"model":"phi/auto","messages":[{"role":"user","content":"Plan it."},{"role":"assistant","content":[{"type":"redacted_thinking","data":"OTHER-DATA"},{"type":"text","text":"Visible answer."}]},{"role":"user","content":"Go on."}],"max_tokens":1000}`;

const redactedFromOther = Effect.gen(function* redactedFromOther() {
	const keys = yield* replyKeys(streamed);
	const request = yield* decodeRequest(otherRedacted, (key) => Array.contains(keys, key), "claude");
	const toOpen = yield* request.encode(clean(request));
	const received = yield* decodeBody(toOpen, strict);
	const [, reply] = received.messages;

	assert.deepStrictEqual(reply, { content: [unknownStub], role: "assistant" });
	assert.notInclude(toOpen, "OTHER-DATA");
});

const clearedAtNextPrompt = String.raw`{"model":"phi/auto","messages":[{"role":"user","content":[{"type":"text","text":"hello there"}]},{"role":"system","content":[{"type":"text","text":"# Environment\n - Platform: linux","cache_control":{"type":"ephemeral","ttl":"1h"}}],"clear_at":"next_user_message"}],"max_tokens":1000}`;

const toolsChanged = String.raw`{"model":"phi/auto","messages":[{"role":"user","content":"hello there"},{"role":"system","content":[{"type":"text","text":"# Environment"},{"type":"tool_addition","tool":{"type":"tool_definition","definition":{"name":"find_note","description":"Finds a note.","input_schema":{"type":"object"}}}},{"type":"tool_removal","tool":{"type":"tool_reference","name":"old_tool"},"cache_control":{"type":"ephemeral","ttl":"1h"}}]}],"max_tokens":1000}`;

const noteOf = (messages: readonly Message[]): string =>
	pipe(
		messages,
		Array.flatMap((message) => {
			if (message.role === "system" && Array.isReadonlyArrayEmpty(message.sections)) {
				return [message.content];
			}

			return [];
		}),
		Array.join(""),
	);

const noteReadWhole = Effect.fnUntraced(function* noteReadWhole(body: string, judged: readonly string[]) {
	const request = yield* decodeRequest(body, nobodyWrote, "claude");
	const toOpen = yield* request.encode(clean(request));
	const received = yield* decodeBody(toOpen, strict);
	const original = yield* decodeBody(body, strict);

	for (const text of judged) {
		assert.include(noteOf(request.messages), text);
	}

	assert.deepStrictEqual(received.messages, original.messages);
	assert.notInclude(toOpen, stubs.unknown);
});

const sealedToolNote = Effect.gen(function* sealedToolNote() {
	const request = yield* decodeRequest(toolsChanged, nobodyWrote, "claude");

	const guarded = pipe(
		request.messages,
		Array.map((message): Message => {
			if (message.role === "system" && Array.isReadonlyArrayEmpty(message.sections)) {
				return { content: stubs.sealed, role: "system", sections: [], tools: [] };
			}

			return message;
		}),
	);

	const toOpen = yield* request.encode({ lane: "clean", messages: guarded, upstreamModel: target });

	assert.include(toOpen, stubs.sealed);
	assert.notInclude(toOpen, "find_note");
	assert.notInclude(toOpen, "old_tool");
});

it.layer(Digest.layerWebCrypto)("harness notes Claude Code 2.1.332 sends", (test) => {
	test.effect("a note marked to clear at the next prompt reaches an open account whole, and the judge reads it", () =>
		noteReadWhole(clearedAtNextPrompt, ["# Environment\n - Platform: linux"]),
	);

	test.effect("a note that adds and removes tools reaches an open account whole, and the judge reads every tool", () =>
		noteReadWhole(toolsChanged, ["# Environment", "find_note", "Finds a note.", "old_tool"]),
	);

	test.effect(
		"a sealed note that adds and removes tools reaches an open account as its stub alone",
		() => sealedToolNote,
	);
});

it.layer(Digest.layerWebCrypto)("content the codec cannot read", (test) => {
	test.effect(
		"a member the clean lane would carry, outside its shape, refuses the clean lane and leaves for the BAA as it came",
		() => refused,
	);

	test.effect("a tool reference reads as the name of its tool, so the judge sees it", () => toolReference);

	test.effect(
		"a reply with redacted thinking the BAA account wrote reaches an open account as the unknown stub",
		() => redactedFromBaa,
	);

	test.effect(
		"a reply with redacted thinking an open account wrote goes back to it unchanged",
		() => redactedFromOpen,
	);

	test.effect(
		"a system block with an unknown key is stubbed on the clean lane and sent as is on the sealed lane",
		() => vendorSystem,
	);

	test.effect(
		"a message with an unknown key decodes, and reaches an open account as the unknown stub",
		() => vendorMessage,
	);

	test.effect(
		"a sealed request with unknown keys below the top and nothing to add leaves as it came",
		() => vendorPinned,
	);

	test.effect(
		"a key that appears twice in one object fails the request and names where, even when one spelling is escaped",
		() => repeatedKey,
	);

	test.effect(
		"a member outside its shape refuses the clean lane, even in a message the codec cannot name",
		() => refusedInUnreadable,
	);

	test.effect(
		"a reply whose redacted thinking differs from what an open account streamed reaches it as the unknown stub",
		() => redactedFromOther,
	);
});
