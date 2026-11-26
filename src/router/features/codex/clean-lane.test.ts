import { Array, Effect, Option, Predicate, Schema, String as Str, Struct, pipe } from "effect";
import type { CleanLaneRefused, ToolsNotCleared } from "#router/features/border/index.ts";
import { assert, it } from "@effect/vitest";
import { cleanBodyPastBorder, h1, nothingWritten } from "./test-kit.ts";
import type { CodexRequestRejected } from "./index.ts";
import { Digest } from "effect/crypto";
import type { Lookup } from "#router/features/verdicts/index.ts";
import type { Message } from "#router/features/parts/index.ts";
import { decodeRequest } from "./index.ts";
import { partsOf } from "#router/features/parts/index.ts";
import { requests } from "./captures/index.ts";
import { sealedStub } from "#router/features/border/index.ts";
import { stubs } from "#router/features/policy/index.ts";

const optionalText = Schema.optionalKey(Schema.String);

const SentItem = Schema.Struct({
	arguments: optionalText,
	call_id: optionalText,
	content: Schema.optionalKey(Schema.Unknown),
	id: optionalText,
	input: optionalText,
	name: optionalText,
	output: Schema.optionalKey(Schema.Unknown),
	type: Schema.String,
});

type Item = typeof SentItem.Type;

const Sent = Schema.fromJsonString(Schema.Struct({ input: Schema.Array(SentItem) }));

const decodeSent = Schema.decodeUnknownEffect(Sent);

const encodeMessages = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const Verdict = Schema.Literals(["cleared", "sealed", "unknown"]);

const Capture = Schema.Literals(["customToolCall", "functionCall", "resumed", "subagentParent"]);

const oneOutput = 1;

const toolListCount = 1;

const sixAsks = 6;

const canary = "chart 4471";

const isCall = ({ type }: Item): boolean => type === "function_call" || type === "custom_tool_call";

const sentItems = (text: string): Effect.Effect<readonly Item[]> =>
	Effect.map(Effect.orDie(decodeSent(text)), ({ input }) => input);

const keysSeen = (
	text: string,
): Effect.Effect<ReadonlySet<string>, CodexRequestRejected | CleanLaneRefused | ToolsNotCleared, Digest.Digest> =>
	Effect.gen(function* lookUp() {
		const seen = new Set<string>();
		const request = yield* decodeRequest(text, nothingWritten);

		const lookup: Lookup = (key) => {
			seen.add(key);

			return "cleared";
		};

		yield* cleanBodyPastBorder(lookup)(request);

		return seen;
	});

const outputKeys = (text: string): Effect.Effect<readonly string[], CodexRequestRejected, Digest.Digest> =>
	Effect.gen(function* keysOfOutputs() {
		const { messages } = yield* decodeRequest(text, nothingWritten);

		const outputs = pipe(
			messages,
			Array.filter(({ role }) => role === "toolResult"),
		);

		const parts = yield* Effect.forEach(outputs, partsOf, { concurrency: 1 });

		return pipe(
			parts,
			Array.flatten,
			Array.map(({ key }) => key),
		);
	});

const outputText = String.raw`{"type":"input_text","text":"Script completed\nWall time 0.2 seconds`;

const outputKeysByText = Effect.gen(function* outputKeysByText() {
	const renamed = Str.replaceAll("call_33b97ed6958b47edb7ab93c98fae0771", "call_renamed")(requests.customToolCall);
	const retimed = Str.replace(outputText, Str.replace("0.2", "0.3")(outputText))(requests.customToolCall);
	const first = yield* outputKeys(requests.customToolCall);
	const again = yield* outputKeys(renamed);
	const changed = yield* outputKeys(retimed);

	assert.lengthOf(first, oneOutput);
	assert.deepStrictEqual(again, first);
	assert.notDeepEqual(changed, first);
});

const reasoningItem = /\{"type":"reasoning","id":"[^"]+","summary":\[\],"encrypted_content":"[^"]+"\},/u;

const reasoningKeys = Effect.gen(function* reasoningKeys() {
	const without = Str.replace(reasoningItem, "")(requests.customToolCall);
	const withReasoning = yield* keysSeen(requests.customToolCall);
	const withoutReasoning = yield* keysSeen(without);

	assert.notStrictEqual(without, requests.customToolCall);
	assert.deepStrictEqual(withoutReasoning, withReasoning);
});

const cmdFirst = String.raw`{\"cmd\":\"cat notes.txt\",\"workdir\":\"/tmp/phi-20/work\",`;

const workdirFirst = String.raw`{\"workdir\":\"/tmp/phi-20/work\",\"cmd\":\"cat notes.txt\",`;

const withEnv = (env: string): string =>
	Str.replace(String.raw`\"workdir\":\"/tmp/phi-20/work\",`, String.raw`\"env\":${env},`)(requests.functionCall);

const argumentsKeys = Effect.gen(function* argumentsKeys() {
	const spaced = Str.replace(String.raw`{\"cmd\":`, String.raw`{ \"cmd\": `)(requests.functionCall);
	const reordered = Str.replace(cmdFirst, workdirFirst)(requests.functionCall);
	const nestedSorted = withEnv(String.raw`{\"home\":\"/tmp\",\"lang\":\"C\"}`);
	const nestedReordered = withEnv(String.raw`{\"lang\":\"C\",\"home\":\"/tmp\"}`);
	const compact = yield* keysSeen(requests.functionCall);
	const respelled = yield* keysSeen(spaced);
	const resorted = yield* keysSeen(reordered);
	const nested = yield* keysSeen(nestedSorted);
	const nestedResorted = yield* keysSeen(nestedReordered);

	assert.notStrictEqual(reordered, requests.functionCall);
	assert.notStrictEqual(nestedSorted, requests.functionCall);
	assert.deepStrictEqual(respelled, compact);
	assert.deepStrictEqual(resorted, compact);
	assert.deepStrictEqual(nestedResorted, nested);
});

const twiceKeys = Effect.gen(function* twiceKeys() {
	const twice = Str.replace(
		String.raw`{\"cmd\":`,
		String.raw`{\"cmd\":\"cat chart_4471.txt\",\"cmd\":`,
	)(requests.functionCall);

	const compact = yield* keysSeen(requests.functionCall);
	const doubled = yield* keysSeen(twice);

	assert.notStrictEqual(twice, requests.functionCall);
	assert.notDeepEqual(doubled, compact);
});

const toolListRefused = (text: string): Effect.Effect<void, CodexRequestRejected | string, Digest.Digest> =>
	Effect.gen(function* refuseToolList() {
		const request = yield* decodeRequest(text, nothingWritten);
		const error = yield* Effect.flip(cleanBodyPastBorder(() => "sealed")(request));

		assert.isTrue(Predicate.isTagged(error, "ToolsNotCleared"));
	});

const frameKeys = (messages: readonly Message[]): Effect.Effect<ReadonlySet<string>, never, Digest.Digest> =>
	Effect.gen(function* keysOfLists() {
		const lists = pipe(
			messages,
			Array.filter((message) => message.role === "system" && Array.isReadonlyArrayNonEmpty(message.tools)),
		);

		const parts = yield* Effect.forEach(lists, partsOf, { concurrency: 1 });

		return new Set(
			pipe(
				parts,
				Array.flatten,
				Array.map(({ key }) => key),
			),
		);
	});

const codexStub = sealedStub("codex")(h1);

const sealedText = [{ text: codexStub, type: "input_text" }];

const allSealedItems = [
	...Array.replicate({ content: sealedText, type: "message" }, sixAsks),
	{ content: [{ annotations: [], logprobs: [], text: codexStub, type: "output_text" }], type: "message" },
	{ call_id: "call_33b97ed6958b47edb7ab93c98fae0771", input: "", name: "exec", type: "custom_tool_call" },
	{ call_id: "call_33b97ed6958b47edb7ab93c98fae0771", output: codexStub, type: "custom_tool_call_output" },
];

const allSealed = Effect.gen(function* allSealed() {
	const request = yield* decodeRequest(requests.customToolCall, nothingWritten);
	const toolList = yield* frameKeys(request.messages);

	const lookup: Lookup = (key) => {
		if (toolList.has(key)) {
			return "cleared";
		}

		return "sealed";
	};

	const encoded = yield* cleanBodyPastBorder(lookup)(request);
	const sent = yield* sentItems(encoded);
	const carried = pipe(sent, Array.drop(toolListCount), Array.map(Struct.omit(["id", "arguments"])));

	assert.deepStrictEqual(carried, allSealedItems);
});

const lookupOf = (inToolList: (key: string) => boolean, verdicts: readonly (typeof Verdict.Type)[]): Lookup => {
	const order = new Map<string, number>();

	return (key) => {
		if (inToolList(key)) {
			return "cleared";
		}

		const index = order.get(key) ?? order.size;

		order.set(key, index);

		return Option.getOrElse(Array.get(verdicts, index % verdicts.length), () => "cleared" as const);
	};
};

const isOutputOf =
	(call: Item) =>
	({ type, call_id: callId }: Item): boolean =>
		!isCall({ type }) && callId === call.call_id;

const callKept = (sent: readonly Item[], call: Item, original: Item): void => {
	const stubbed = call.arguments !== original.arguments || call.input !== original.input;

	assert.deepStrictEqual([call.id, call.name, call.call_id], [original.id, original.name, original.call_id]);
	const answered = pipe(sent, Array.some(isOutputOf(call)));

	assert.isTrue(answered);
	assert.isTrue(!stubbed || call.arguments === "{}" || call.input === "");
};

const anyLookup = ({
	capture,
	verdicts,
}: {
	readonly capture: typeof Capture.Type;
	readonly verdicts: readonly (typeof Verdict.Type)[];
}): Effect.Effect<void, CodexRequestRejected | CleanLaneRefused | ToolsNotCleared, Digest.Digest> =>
	Effect.gen(function* encodeAnyLookup() {
		const text = requests[capture];
		const request = yield* decodeRequest(text, nothingWritten);

		const lookup = yield* Effect.map(frameKeys(request.messages), (toolList) =>
			lookupOf((key) => toolList.has(key), verdicts),
		);

		const encoded = yield* cleanBodyPastBorder(lookup)(request);

		const original = yield* Effect.map(sentItems(text), Array.filter(isCall));
		const sent = yield* sentItems(encoded);

		const calls = pipe(sent, Array.filter(isCall));

		assert.lengthOf(calls, original.length);

		for (const [call, originalCall] of Array.zip(calls, original)) {
			callKept(sent, call, originalCall);
		}
	});

const partField = Effect.gen(function* partField() {
	const text = Str.replace(
		'{"type":"input_text","text":"Run the shell',
		`{"type":"input_text","future_key":"${canary}","text":"Run the shell`,
	)(requests.firstTurn);

	const request = yield* decodeRequest(text, nothingWritten);
	const clean = yield* cleanBodyPastBorder(() => "cleared")(request);

	assert.notStrictEqual(text, requests.firstTurn);
	assert.notInclude(clean, canary);
	assert.include(clean, stubs.unknown);
});

const unreadItem = Effect.gen(function* unreadItem() {
	const text = Str.replace('"input":[', `"input":[{"type":"future_item","note":"${canary}"},`)(requests.firstTurn);
	const { messages } = yield* decodeRequest(text, nothingWritten);
	const read = yield* Effect.orDie(encodeMessages(messages));

	assert.deepInclude(messages, { content: [], role: "user" });
	assert.notInclude(read, canary);
});

const inputNotAList = Effect.gen(function* inputNotAList() {
	const { messages } = yield* decodeRequest(`{"model":"phi/auto","input":"${canary}"}`, nothingWritten);

	assert.deepStrictEqual(messages, []);
});

it.layer(Digest.layerWebCrypto)("Codex clean lane", (test) => {
	test.effect("a tool output keeps its key under a new call id, and new text changes it", () => outputKeysByText);
	test.effect("a request that differs only in a reasoning item looks up the same keys", () => reasoningKeys);
	test.effect("call arguments spelled another way look up the same keys", () => argumentsKeys);
	test.effect("call arguments that name a key twice look up their own keys", () => twiceKeys);
	test.effect("every part sealed but the tool list goes as the border's stub, each item and id kept", () => allSealed);
	test.effect.each([requests.customToolCall, requests.functionCall])(
		"a tool list not cleared refuses the clean lane",
		(text) => toolListRefused(text),
	);

	test.effect.prop(
		"whatever the lookup says, each call keeps its id, its name and its output, and a stubbed call keeps no content",
		{ capture: Capture, verdicts: Schema.NonEmptyArray(Verdict) },
		anyLookup,
	);
	test.effect("a text part with a field the codec does not know goes as the stub, though cleared", () => partField);
	test.effect("an item the codec cannot read is an empty user message", () => unreadItem);
	test.effect("a body whose input is not a list reads as no message", () => inputNotAList);
});
