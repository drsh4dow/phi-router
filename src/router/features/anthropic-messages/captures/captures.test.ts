import { Array, Effect, Exit, Record, Result, Schema, String as Str, pipe } from "effect";
import {
	UnreadableReply,
	UnreadableRequest,
	decodeRequest,
	replyKeys,
} from "#router/features/anthropic-messages/index.ts";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import { requests } from "./index.ts";
import { toolCallReply } from "./tool-call.ts";

const nobodyWrote = (): boolean => false;

const everyCapture = Effect.gen(function* everyCapture() {
	for (const [name, body] of Record.toEntries(requests)) {
		const decoded = yield* Effect.result(decodeRequest(body, nobodyWrote, "claude"));

		if (Result.isFailure(decoded)) {
			assert.fail(`${name} does not decode: ${decoded.failure.reason}`);
		}
	}
});

const unknownField = Effect.gen(function* unknownField() {
	const body = Str.replace('"stream":true}', '"stream":true,"temperature":"PATIENT-SECRET"}')(requests.toolResult);
	const failure = yield* Effect.flip(decodeRequest(body, nobodyWrote, "claude"));

	assert.instanceOf(failure, UnreadableRequest);
	assert.include(failure.reason, "temperature");
	assert.notInclude(failure.reason, "PATIENT-SECRET");
});

const retried = Effect.gen(function* retried() {
	const body = Str.replace(
		'"thinking":{"type":"adaptive","display":"updates"}',
		'"thinking":{"type":"adaptive"}',
	)(requests.toolResult);

	assert.notStrictEqual(body, requests.toolResult);
	yield* decodeRequest(body, nobodyWrote, "claude");
});

const openThinking = '{"type":"thinking","thinking":"","signature":"signature-placeholder"}';

const echoOf = Effect.fnUntraced(function* echoOf(body: string) {
	const keys = yield* replyKeys(toolCallReply);
	const request = yield* decodeRequest(body, (key) => Array.contains(keys, key), "claude");
	const clean = yield* request.encode({ lane: "clean", messages: request.messages, upstreamModel: "claude-target" });

	const writers = pipe(
		request.messages,
		Array.flatMap((message) => {
			if (message.role === "assistant") {
				return [message.writtenBy];
			}

			return [];
		}),
	);

	return { clean, writers };
});

const echoedReply = Effect.gen(function* echoedReply() {
	const { clean, writers } = yield* echoOf(requests.toolResult);

	assert.deepStrictEqual(writers, ["other", "open-account"]);
	assert.include(clean, openThinking);
});

const rewrittenInput = Effect.gen(function* rewrittenInput() {
	const body = Str.replace(
		'"input":{"file_path":"/tmp/phi-16/work/notes.txt"}',
		'"input":{"file_path":"/tmp/phi-16/work/notes.txt","limit":2000}',
	)(requests.toolResult);

	assert.notStrictEqual(body, requests.toolResult);
	const { clean, writers } = yield* echoOf(body);

	assert.deepStrictEqual(writers, ["other", "other"]);
	assert.include(clean, openThinking);
});

const baaThinking = '{"type":"thinking","thinking":"BAA-THOUGHT","signature":"baa-signature"}';

const otherThinking = Effect.gen(function* otherThinking() {
	const body = Str.replaceAll(openThinking, baaThinking)(requests.toolResult);
	const { clean, writers } = yield* echoOf(body);

	assert.deepStrictEqual(writers, ["other", "open-account"]);
	assert.notInclude(clean, "BAA-THOUGHT");
	assert.notInclude(clean, "baa-signature");
});

const mixedThinking = Effect.gen(function* mixedThinking() {
	const body = Str.replaceAll(openThinking, `${openThinking},${baaThinking}`)(requests.toolResult);
	const { clean } = yield* echoOf(body);

	assert.include(clean, openThinking);
	assert.notInclude(clean, "BAA-THOUGHT");
	assert.notInclude(clean, "baa-signature");
});

const cutReply = Effect.gen(function* cutReply() {
	const cut = pipe(toolCallReply, Str.split("event: message_stop"), Array.headNonEmpty);
	const failed = `${cut}event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;

	const cutFailure = yield* Effect.flip(replyKeys(cut));
	const failedFailure = yield* Effect.flip(replyKeys(failed));

	assert.instanceOf(cutFailure, UnreadableReply);
	assert.instanceOf(failedFailure, UnreadableReply);
});

const placeholderIds = { account_uuid: "", device_id: "device-id-placeholder", session_id: "session-id-placeholder" };

const RecordedMetadata = Schema.Struct({ user_id: Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)) });

const RecordedRequest = Schema.fromJsonString(Schema.Struct({ metadata: Schema.optionalKey(RecordedMetadata) }));

const placeholders = Effect.gen(function* placeholders() {
	const recorded = yield* Effect.forEach(
		Record.values(requests),
		(body) => Schema.decodeEffect(RecordedRequest)(body),
		{ concurrency: 1 },
	);

	const ids = pipe(
		recorded,
		Array.flatMap((body) => Array.fromNullishOr(body.metadata)),
		Array.map((metadata) => metadata.user_id),
	);

	assert.isNotEmpty(ids);

	for (const each of ids) {
		assert.deepStrictEqual(each, placeholderIds);
	}
});

const enabledThinking = Effect.gen(function* enabledThinking() {
	const body = Str.replace(
		'"thinking":{"type":"adaptive","display":"updates"}',
		'"thinking":{"type":"enabled","budget_tokens":1024}',
	)(requests.toolResult);

	assert.notStrictEqual(body, requests.toolResult);
	const failure = yield* Effect.flip(decodeRequest(body, nobodyWrote, "claude"));

	assert.instanceOf(failure, UnreadableRequest);
	assert.include(failure.reason, "thinking");
});

const twoResults = String.raw`{"model":"phi/auto","messages":[{"role":"user","content":"Read both."},{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{}},{"type":"tool_use","id":"toolu_2","name":"Read","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"one"},{"type":"tool_result","tool_use_id":"toolu_2","content":"two"},{"type":"text","text":"Go on."}]}],"max_tokens":1000}`;

const resultMessages = Effect.gen(function* resultMessages() {
	const request = yield* decodeRequest(twoResults, nobodyWrote, "claude");

	const roles = pipe(
		request.messages,
		Array.map((message) => message.role),
	);

	const answered = pipe(
		request.messages,
		Array.flatMap((message) => {
			if (message.role === "toolResult") {
				return [message.toolCallId];
			}

			return [];
		}),
	);

	assert.deepStrictEqual(roles, ["system", "user", "assistant", "toolResult", "toolResult", "user"]);
	assert.deepStrictEqual(answered, ["toolu_1", "toolu_2"]);
});

const lostMessages = 1;

const misaligned = Effect.gen(function* misaligned() {
	const request = yield* decodeRequest(requests.toolResult, nobodyWrote, "claude");
	const messages = Array.dropRight(request.messages, lostMessages);
	const sent = yield* Effect.exit(request.encode({ lane: "clean", messages, upstreamModel: "claude-target" }));

	assert.isTrue(Exit.hasDies(sent));
});

const blankBlock =
	'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"\\n\\n"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n';

const beforeMessageDelta =
	(event: string) =>
	(reply: string): string =>
		Str.replace("event: message_delta", `${event}event: message_delta`)(reply);

const blankText = Effect.gen(function* blankText() {
	const withBlank = yield* replyKeys(beforeMessageDelta(blankBlock)(toolCallReply));
	const without = yield* replyKeys(toolCallReply);

	assert.deepStrictEqual(withBlank, without);
});

const alteredThinking = Effect.gen(function* alteredThinking() {
	const resigned = Str.replaceAll(
		openThinking,
		'{"type":"thinking","thinking":"","signature":"forged-signature"}',
	)(requests.toolResult);

	const rethought = Str.replaceAll(
		openThinking,
		'{"type":"thinking","thinking":"ALTERED-THOUGHT","signature":"signature-placeholder"}',
	)(requests.toolResult);

	const fromResigned = yield* echoOf(resigned);
	const fromRethought = yield* echoOf(rethought);

	assert.notInclude(fromResigned.clean, "forged-signature");
	assert.notInclude(fromRethought.clean, "ALTERED-THOUGHT");
});

const unfoldable = [
	'event: new_event\ndata: {"type":"new_event"}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"new_delta"}}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"x"}}\n\n',
];

const unfoldableReply = Effect.gen(function* unfoldableReply() {
	for (const event of unfoldable) {
		const failure = yield* Effect.flip(replyKeys(beforeMessageDelta(event)(toolCallReply)));

		assert.instanceOf(failure, UnreadableReply);
	}
});

it.layer(Digest.layerWebCrypto)("captured requests", (test) => {
	test.effect("every captured request decodes", () => everyCapture);

	test.effect("Claude Code's retry after a 400, which drops thinking's display, decodes", () => retried);
	test.effect("an unknown top-level field fails the request and names the field, not its value", () => unknownField);

	test.effect(
		"a streamed reply's keys match its echo, so that reply reads as the open account's and keeps its thinking",
		() => echoedReply,
	);

	test.effect(
		"an echo whose tool input Claude Code rewrote reads as other, and keeps the thinking the open account streamed",
		() => rewrittenInput,
	);

	test.effect(
		"thinking the open account did not stream never reaches the clean lane, though the rest matches its reply",
		() => otherThinking,
	);

	test.effect(
		"in a reply mixing streamed and other thinking, only the streamed block reaches the clean lane",
		() => mixedThinking,
	);

	test.effect("a streamed reply cut before message_stop, or holding an error event, gives no key", () => cutReply);

	test.effect("every capture's metadata ids are the fixed placeholders", () => placeholders);

	test.effect(
		"a top-level field outside its recorded shape fails the request and names the field",
		() => enabledThinking,
	);

	test.effect(
		"the system message comes first, then one message per turn, and each tool result of a user turn is its own message",
		() => resultMessages,
	);

	test.effect("the clean lane dies when the border's messages do not line up with the request's", () => misaligned);

	test.effect(
		"a blank text block, which Claude Code drops from its echo, leaves a streamed reply's keys alone",
		() => blankText,
	);

	test.effect(
		"thinking whose text or signature differs from the block the open account streamed never reaches the clean lane",
		() => alteredThinking,
	);

	test.effect(
		"a streamed reply with an unknown event, an unknown delta, or a delta its block cannot take gives no key",
		() => unfoldableReply,
	);
});
