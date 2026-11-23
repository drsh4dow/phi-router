import { Array, Effect, Record, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import { compaction } from "./captures/compaction.ts";
import { decodeRequest } from "./index.ts";
import { firstTurn } from "./captures/first-turn.ts";
import { subagent } from "./captures/subagent.ts";
import { toolResult } from "./captures/tool-result.ts";

const requests = { compaction, firstTurn, subagent, toolResult };

const bridge =
	"Refer to patients and members only by internal ids, such as a patient_id or a row id, never by name, SSN, date of birth, address, phone, email, member number or record number. A message shown as [withheld: holds patient identifiers, handled on the HIPAA account] was handled on the HIPAA account. When the newest user message holds patient identifiers, open your reply by restating what was asked without them, because later requests will not include that message. When the work cannot be done without the identifiers themselves, hand it to the phi-router:phi-sealed subagent and put the identifiers it needs in its prompt, because it cannot see this conversation.";

/** Where `system` ends in every capture: its last block closes, then `tools` opens. */
const systemEnd = '}],"tools":[';

/** A body split at its one end of `system` gives two pieces. */
const oneEnd = 2;

const nobodyWrote = (): boolean => false;

const target = "claude-target";

/** Above 2^53, so a JSON.parse round trip would turn it into 9007199254740992. */
const input = '{"row":9007199254740993}';

const schema = '{"type":"object","properties":{"row":{"type":"integer","maximum":9007199254740993}}}';

const bigNumbers = `{"model":"phi/auto","messages":[{"role":"user","content":"Read the row."},{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Lookup","input":${input}}]},{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"found"}]}],"tools":[{"name":"Lookup","description":"Reads a row.","input_schema":${schema}}],"max_tokens":1000}`;

/** Spaced out, keys in another order than Claude Code's. */
const spaced = `{
  "max_tokens" : 1000,
  "tools": [ { "input_schema": ${schema}, "description": "Reads a row.", "name": "Lookup" } ],
  "messages": [ { "content": "Read the row.", "role": "user" } ],
  "model": "phi/auto"
}`;

const pinnedIsIdentity = Effect.gen(function* pinnedIsIdentity() {
	for (const [name, body] of Record.toEntries(requests)) {
		const request = yield* decodeRequest(body, nobodyWrote, "claude");
		const sent = yield* request.encode({ lane: "sealed", model: request.model, pinned: true });

		assert.strictEqual(sent, body, `${name} changed on its way through`);
	}
});

const sealedAddsOnlyTheBridge = Effect.gen(function* sealedAddsOnlyTheBridge() {
	for (const [name, body] of Record.toEntries(requests)) {
		const request = yield* decodeRequest(body, nobodyWrote, "claude");
		const sent = yield* request.encode({ lane: "sealed", model: request.model, pinned: false });

		assert.lengthOf(Str.split(body, systemEnd), oneEnd, `${name} has one end of system`);
		assert.strictEqual(sent, Str.replace(systemEnd, `},{"type":"text","text":"${bridge}"${systemEnd}`)(body), name);
	}
});

const numbersAsSent = Effect.gen(function* numbersAsSent() {
	const request = yield* decodeRequest(bigNumbers, nobodyWrote, "claude");

	const lanes = [
		yield* request.encode({ lane: "sealed", model: target, pinned: true }),
		yield* request.encode({ lane: "sealed", model: target, pinned: false }),
		yield* request.encode({ lane: "clean", messages: request.messages, model: target }),
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

	assert.deepStrictEqual(declared, [{ description: "Reads a row.", name: "Lookup", parameters: schema }]);
	assert.deepStrictEqual(replied, [{ arguments: input, id: "toolu_1", name: "Lookup", type: "toolCall" }]);

	for (const sent of lanes) {
		assert.include(sent, `"input":${input}`);
		assert.include(sent, `"input_schema":${schema}`);
	}
});

const pinnedKeepsSpacing = Effect.gen(function* pinnedKeepsSpacing() {
	const request = yield* decodeRequest(spaced, nobodyWrote, "claude");
	const sent = yield* request.encode({ lane: "sealed", model: target, pinned: true });

	assert.strictEqual(sent, Str.replace('"model": "phi/auto"', `"model": "${target}"`)(spaced));
});

it.layer(Digest.layerWebCrypto)("decode then encode", (test) => {
	test.effect("gives each captured request's bytes back when pinned to its own model", () => pinnedIsIdentity);

	test.effect("adds only the bridge, after the last system block, on the sealed lane", () => sealedAddsOnlyTheBridge);

	test.effect(
		"sends every number as the harness wrote it, on every lane, and the engine reads its digits",
		() => numbersAsSent,
	);

	test.effect("changes only the model of a pinned body, whatever its spacing and key order", () => pinnedKeepsSpacing);
});
