import { Array, Effect, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import type { Part } from "#router/features/parts/index.ts";
import type { UnreadableRequest } from "./index.ts";
import { decodeRequest } from "./index.ts";
import { partsOf } from "#router/features/parts/index.ts";
import { requests } from "./captures/index.ts";

const callId = "toolu_01QLmmERkcyuzj56mJxsGPcP";

const thinking = '{"type":"thinking","thinking":"","signature":"signature-placeholder"},';

const nobodyWrote = (): boolean => false;

const partsIn = Effect.fnUntraced(function* partsIn(body: string) {
	const request = yield* decodeRequest(body, nobodyWrote, "claude");
	const parts = yield* Effect.forEach(request.messages, partsOf, { concurrency: 1 });

	return { parts: Array.flatten(parts), request };
});

const keysIn = (body: string): Effect.Effect<readonly Part["key"][], UnreadableRequest, Digest.Digest> =>
	Effect.map(partsIn(body), ({ parts }) =>
		pipe(
			parts,
			Array.map((part) => part.key),
		),
	);

const resultKey = Effect.fnUntraced(function* resultKey(body: string) {
	const request = yield* decodeRequest(body, nobodyWrote, "claude");

	const results = pipe(
		request.messages,
		Array.filter((message) => message.role === "toolResult"),
	);

	const parts = yield* Effect.forEach(results, partsOf, { concurrency: 1 });

	return Array.flatten(parts);
});

const inventory = Effect.gen(function* inventory() {
	const { parts, request } = yield* partsIn(requests.toolResult);

	assert.deepStrictEqual(
		pipe(
			request.messages,
			Array.map((message) => message.role),
		),
		["system", "user", "system", "assistant", "user", "system", "assistant", "toolResult", "system"],
	);

	assert.deepStrictEqual(
		pipe(
			parts,
			Array.map(({ slot: { _tag: tag } }) => tag),
		),
		[
			"SystemContent",
			"SystemSection",
			"SystemSection",
			"SystemTools",
			"Message",
			"SystemContent",
			"Message",
			"Message",
			"SystemContent",
			"Message",
			"Message",
			"SystemContent",
		],
	);
});

const renamedCall = Effect.gen(function* renamedCall() {
	const first = yield* resultKey(requests.toolResult);
	const renamed = yield* resultKey(Str.replaceAll(callId, "toolu_01RenamedCallId0000000000")(requests.toolResult));
	const edited = yield* resultKey(Str.replace("The end.", "The end!")(requests.toolResult));

	assert.deepStrictEqual(renamed, first);
	assert.notDeepEqual(edited, first);
});

const thinkingFree = Effect.gen(function* thinkingFree() {
	const first = yield* keysIn(requests.toolResult);

	const resigned = yield* keysIn(
		Str.replaceAll('"signature-placeholder"', '"another-signature"')(requests.toolResult),
	);

	const removed = yield* keysIn(Str.replace(thinking, "")(requests.toolResult));

	assert.deepStrictEqual(resigned, first);
	assert.deepStrictEqual(removed, first);
});

it.layer(Digest.layerWebCrypto)("content keys of a captured request", (test) => {
	test.effect("each message, system section and the tool list is a part", () => inventory);

	test.effect(
		"a tool result keeps its key under another call id, and one changed character changes it",
		() => renamedCall,
	);

	test.effect("a changed or removed thinking block leaves every key equal", () => thinkingFree);
});
