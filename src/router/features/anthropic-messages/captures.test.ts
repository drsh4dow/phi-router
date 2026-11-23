import { Array, Effect, Record, Result, String as Str, pipe } from "effect";
import { UnreadableReply, UnreadableRequest, decodeRequest, replyKeys } from "./index.ts";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import { requests } from "./captures/requests.ts";
import { toolCallReply } from "./captures/tool-call.ts";
import { toolResult } from "./captures/tool-result.ts";

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
	const body = Str.replace('"stream":true}', '"stream":true,"temperature":"PATIENT-SECRET"}')(toolResult);
	const failure = yield* Effect.flip(decodeRequest(body, nobodyWrote, "claude"));

	assert.instanceOf(failure, UnreadableRequest);
	assert.include(failure.reason, "temperature");
	assert.notInclude(failure.reason, "PATIENT-SECRET");
});

const retried = Effect.gen(function* retried() {
	const body = Str.replace(
		'"thinking":{"type":"adaptive","display":"updates"}',
		'"thinking":{"type":"adaptive"}',
	)(toolResult);

	assert.notStrictEqual(body, toolResult);
	yield* decodeRequest(body, nobodyWrote, "claude");
});

const openThinking = '{"type":"thinking","thinking":"","signature":"signature-placeholder"}';

/**
 * How `body` reads and what the clean lane sends for it, under the keys of the open account's streamed `toolCallReply`.
 *
 * @param {string} body A request.
 * @returns {Effect.Effect} Who wrote each reply, and the clean body with every part cleared.
 */
const echoOf = Effect.fnUntraced(function* echoOf(body: string) {
	const keys = yield* replyKeys(toolCallReply);
	const request = yield* decodeRequest(body, (key) => Array.contains(keys, key), "claude");
	const clean = yield* request.encode({ lane: "clean", messages: request.messages, model: "claude-target" });

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
	const { clean, writers } = yield* echoOf(toolResult);

	assert.deepStrictEqual(writers, ["other", "open-account"]);
	assert.include(clean, openThinking);
});

const rewrittenInput = Effect.gen(function* rewrittenInput() {
	const body = Str.replace(
		'"input":{"file_path":"/tmp/phi-16/work/notes.txt"}',
		'"input":{"file_path":"/tmp/phi-16/work/notes.txt","limit":2000}',
	)(toolResult);

	assert.notStrictEqual(body, toolResult);
	const { clean, writers } = yield* echoOf(body);

	assert.deepStrictEqual(writers, ["other", "other"]);
	assert.include(clean, openThinking);
});

const baaThinking = '{"type":"thinking","thinking":"BAA-THOUGHT","signature":"baa-signature"}';

const otherThinking = Effect.gen(function* otherThinking() {
	const body = Str.replaceAll(openThinking, baaThinking)(toolResult);
	const { clean, writers } = yield* echoOf(body);

	assert.deepStrictEqual(writers, ["other", "open-account"]);
	assert.notInclude(clean, "BAA-THOUGHT");
	assert.notInclude(clean, "baa-signature");
});

const mixedThinking = Effect.gen(function* mixedThinking() {
	const body = Str.replaceAll(openThinking, `${openThinking},${baaThinking}`)(toolResult);
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
});
