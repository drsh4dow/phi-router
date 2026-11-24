import type { CleanLaneRefused, CodexRequest, CodexRequestRejected } from "./index.ts";
import { Effect, Predicate, String as Str } from "effect";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import type { Lookup } from "#router/features/verdicts/index.ts";
import type { ToolsNotCleared } from "#router/features/border/index.ts";
import { decodeRequest } from "./index.ts";
import { guard } from "#router/features/border/index.ts";
import { requests } from "./captures/index.ts";
import { stubs } from "#router/features/policy/index.ts";

const realModel = "gpt-5.5";

const canary = "chart 4471";

const oneStub = 1;

const allCleared: Lookup = () => "cleared";

const nothingWritten = (): boolean => false;

const cleanOf = (
	request: Pick<CodexRequest, "encode" | "messages">,
	lookup: Lookup,
): Effect.Effect<string, CleanLaneRefused | ToolsNotCleared, Digest.Digest> =>
	Effect.flatMap(guard({ harness: "codex", lookup, messages: request.messages }), (messages) =>
		request.encode({ lane: "clean", messages, model: realModel }),
	);

const futureItem = Str.replace('"input":[', `"input":[{"type":"future_item","note":"${canary}"},`);

const inTurnMetadata = (added: string): ((text: string) => string) =>
	Str.replace('"x-codex-turn-metadata":"{', `"x-codex-turn-metadata":"{${added}`);

const sealedAsSent = (
	text: string,
): Effect.Effect<CodexRequest, CodexRequestRejected | CleanLaneRefused, Digest.Digest> =>
	Effect.gen(function* decodeAndSeal() {
		const request = yield* decodeRequest(text, nothingWritten);
		const sealed = yield* request.encode({ lane: "sealed", model: request.model, pinned: true });

		assert.strictEqual(sealed, text);

		return request;
	});

const stubbedCase = ([, text]: readonly [string, string]): Effect.Effect<
	void,
	CodexRequestRejected | CleanLaneRefused | ToolsNotCleared,
	Digest.Digest
> =>
	Effect.gen(function* stubOnClean() {
		const request = yield* sealedAsSent(text);
		const clean = yield* cleanOf(request, allCleared);
		const stubCount = Str.split(clean, stubs.unknown).length - oneStub;

		assert.strictEqual(stubCount, oneStub);
		assert.notInclude(clean, canary);
		assert.notInclude(clean, "future_");
	});

const refusedCase = ([, text]: readonly [string, string]): Effect.Effect<
	void,
	CodexRequestRejected | CleanLaneRefused | ToolsNotCleared | string,
	Digest.Digest
> =>
	Effect.gen(function* refuseClean() {
		const request = yield* sealedAsSent(text);
		const error = yield* Effect.flip(cleanOf(request, allCleared));

		assert.isTrue(Predicate.isTagged(error, "CleanLaneRefused"));
	});

const stubbed = [
	["an item of a type the codec does not know", futureItem(requests.firstTurn)],
	[
		"a known item with a key the codec does not know",
		Str.replace(
			'"role":"user","content":[{"type":"input_text","text":"Run the shell',
			`"role":"user","future_key":"${canary}","content":[{"type":"input_text","text":"Run the shell`,
		)(requests.firstTurn),
	],
	[
		"reasoning of a type the codec does not know",
		Str.replace('"type":"reasoning"', '"type":"future_reasoning"')(requests.customToolCall),
	],
	[
		"a pinned request with an item the codec does not know",
		Str.replace('{"model":"phi/auto"', '{"model":"phi/sealed"')(futureItem(requests.firstTurn)),
	],
] as const;

const refused = [
	[
		"a call with a key the codec does not know",
		Str.replace(
			'"type":"function_call","status":"completed"',
			'"type":"function_call","future_key":"x","status":"completed"',
		)(requests.functionCall),
	],
	["an unknown key in the turn metadata", inTurnMetadata(String.raw`\"future_key\":\"x\",`)(requests.firstTurn)],
	["turn metadata Codex did not write compact", inTurnMetadata(" ")(requests.firstTurn)],
	[
		"turn metadata that names a key twice",
		inTurnMetadata(String.raw`\"agent_name\":\"${canary}\",`)(requests.firstTurn),
	],
	[
		"a setting that is not a word",
		Str.replace(String.raw`\"sandbox\":\"`, String.raw`\"sandbox\":\"${canary} `)(requests.firstTurn),
	],
	[
		"an unknown key in client_metadata",
		Str.replace('"client_metadata":{', '"client_metadata":{"future_key":"x",')(requests.firstTurn),
	],
	[
		"a prompt_cache_key that is not an id",
		Str.replace(/"prompt_cache_key":"[^"]+"/u, `"prompt_cache_key":"${canary}"`)(requests.firstTurn),
	],
	["a known top-level field of another shape", Str.replace('"stream":true', '"stream":"yes"')(requests.firstTurn)],
] as const;

it.layer(Digest.layerWebCrypto)("what the codec cannot read", (test) => {
	test.effect.each(stubbed)("%s decodes, goes sealed as sent, and clean as the stub", stubbedCase);
	test.effect.each(refused)("%s decodes, goes sealed as sent, and refuses the clean lane", refusedCase);
});
