import { Array, Effect, Function, Record, String as Str, Struct, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import { bridgesFor } from "#router/features/border/index.ts";
import { requests as captured } from "./captures/index.ts";
import { decodeRequest } from "./index.ts";

const requests = Struct.pick(captured, ["compaction", "firstTurn", "subagent", "toolResult"]);

const bridge = bridgesFor.claude;

const systemThenTools = '}],"tools":[';

const piecesAroundOneEnd = 2;

const nobodyWrote = (): boolean => false;

const target = "claude-target";

const inputAboveMaxSafeInteger = '{"row":9007199254740993}';

const schemaAboveMaxSafeInteger =
	'{"type":"object","properties":{"row":{"type":"integer","maximum":9007199254740993}}}';

const bigNumbers = `{"model":"phi/auto","messages":[{"role":"user","content":"Read the row."},{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Lookup","input":${inputAboveMaxSafeInteger}}]},{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"found"}]}],"tools":[{"name":"Lookup","description":"Reads a row.","input_schema":${schemaAboveMaxSafeInteger}}],"max_tokens":1000}`;

const spaced = `{
  "max_tokens" : 1000,
  "tools": [ { "input_schema": ${schemaAboveMaxSafeInteger}, "description": "Reads a row.", "name": "Lookup" } ],
  "messages": [ { "content": "Read the row.", "role": "user" } ],
  "model": "phi/auto"
}`;

const sealedAddsOnlyTheBridge = Effect.gen(function* sealedAddsOnlyTheBridge() {
	for (const [name, body] of Record.toEntries(requests)) {
		const request = yield* decodeRequest(body, nobodyWrote, "claude");

		const sent = yield* request.encode({
			added: [bridgesFor.claude],
			lane: "sealed",
			open: Function.identity,
			upstreamModel: request.model,
		});

		assert.lengthOf(Str.split(body, systemThenTools), piecesAroundOneEnd, `${name} has one end of system`);
		assert.strictEqual(
			sent,
			Str.replace(systemThenTools, `},{"type":"text","text":"${bridge}"${systemThenTools}`)(body),
			name,
		);
	}
});

const numbersAsSent = Effect.gen(function* numbersAsSent() {
	const request = yield* decodeRequest(bigNumbers, nobodyWrote, "claude");

	const lanes = [
		yield* request.encode({
			added: [bridgesFor.claude],
			lane: "sealed",
			open: Function.identity,
			upstreamModel: target,
		}),
		yield* request.encode({ lane: "clean", messages: request.messages, upstreamModel: target }),
	];

	const declared = pipe(
		request.messages,
		Array.flatMap((message) => {
			if (message.role === "system") {
				return message.tools;
			}

			return [];
		}),
	);

	const replied = pipe(
		request.messages,
		Array.flatMap((message) => {
			if (message.role === "assistant") {
				return message.content;
			}

			return [];
		}),
	);

	assert.deepStrictEqual(declared, [
		{ description: "Reads a row.", name: "Lookup", parameters: schemaAboveMaxSafeInteger },
	]);
	assert.deepStrictEqual(replied, [
		{ arguments: inputAboveMaxSafeInteger, id: "toolu_1", name: "Lookup", type: "toolCall" },
	]);

	for (const sent of lanes) {
		assert.include(sent, `"input":${inputAboveMaxSafeInteger}`);
		assert.include(sent, `"input_schema":${schemaAboveMaxSafeInteger}`);
	}
});

const sealedKeepsSpacing = Effect.gen(function* sealedKeepsSpacing() {
	const request = yield* decodeRequest(spaced, nobodyWrote, "claude");

	const sent = yield* request.encode({
		added: [],
		lane: "sealed",
		open: Function.identity,
		upstreamModel: target,
	});

	assert.strictEqual(sent, Str.replace('"model": "phi/auto"', `"model": "${target}"`)(spaced));
});

it.layer(Digest.layerWebCrypto)("decode then encode", (test) => {
	test.effect("adds only the bridge, after the last system block, on the sealed lane", () => sealedAddsOnlyTheBridge);

	test.effect(
		"sends every number as the harness wrote it, on every lane, and the engine reads its digits",
		() => numbersAsSent,
	);

	test.effect(
		"changes only the model of a sealed body with nothing to add, whatever its spacing and key order",
		() => sealedKeepsSpacing,
	);
});
