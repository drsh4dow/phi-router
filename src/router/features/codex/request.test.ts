import { Array, Effect, Exit, Option, Predicate, Record, Schema, String as Str, pipe } from "effect";
import type { CleanLaneRefused, CodexRequest, CodexRequestRejected } from "./index.ts";
import { assert, it } from "@effect/vitest";
import { bridgesFor, guard } from "#router/features/border/index.ts";
import { cleanLaneKeys, decodeRequest } from "./index.ts";
import { replies, requests } from "./captures/index.ts";
import { Digest } from "effect/crypto";
import type { Lookup } from "#router/features/verdicts/index.ts";
import type { Message } from "#router/features/parts/index.ts";
import type { ToolsNotCleared } from "#router/features/border/index.ts";
import { stubs } from "#router/features/policy/index.ts";

const optionalText = Schema.optionalKey(Schema.String);

const SentItem = Schema.Struct({
	arguments: optionalText,
	call_id: optionalText,
	content: Schema.optionalKey(Schema.Unknown),
	type: Schema.String,
});

const Sent = Schema.fromJsonString(
	Schema.Struct({ input: Schema.Array(SentItem), instructions: Schema.String, model: Schema.String }),
);

const decodeSent = Schema.decodeUnknownEffect(Sent);

const sentOf = (text: string): Effect.Effect<typeof Sent.Type> => Effect.orDie(decodeSent(text));

const realModel = "gpt-5.5";

const canary = "chart 4471";

const liteTools = 3;

const fallbackTools = 22;

const nothingWritten = (): boolean => false;

const allCleared: Lookup = () => "cleared";

const reasoningItem = /\{"type":"reasoning","id":"[^"]+","summary":\[\],"encrypted_content":"[^"]+"\},/u;

const withRealModel = Str.replace('{"model":"phi/auto",', `{"model":"${realModel}",`);

const withBridge = Str.replace(/^(?<head>\{"model":"[^"]*")/u, `$<head>,"instructions":"${bridgesFor.codex}"`);

const decoded = (text: string): Effect.Effect<CodexRequest, CodexRequestRejected, Digest.Digest> =>
	decodeRequest(text, nothingWritten);

const decodedAfter = (text: string, reply: string): Effect.Effect<CodexRequest, CodexRequestRejected, Digest.Digest> =>
	Effect.gen(function* afterReply() {
		const keys = yield* cleanLaneKeys(reply);
		const written = new Set(keys);

		return yield* decodeRequest(text, (key) => written.has(key));
	});

const cleanOf = (
	request: Pick<CodexRequest, "encode" | "messages">,
	lookup: Lookup,
): Effect.Effect<string, CleanLaneRefused | ToolsNotCleared, Digest.Digest> =>
	Effect.flatMap(guard({ harness: "codex", lookup, messages: request.messages }), (messages) =>
		request.encode({ lane: "clean", messages, model: realModel }),
	);

const cleanBody = (
	request: Pick<CodexRequest, "encode" | "messages">,
): Effect.Effect<typeof Sent.Type, CleanLaneRefused | ToolsNotCleared, Digest.Digest> =>
	Effect.flatMap(cleanOf(request, allCleared), sentOf);

const firstTools = (messages: readonly Message[]): readonly unknown[] =>
	Option.match(Array.head(messages), {
		onNone: () => [],
		onSome: (message) => {
			if (message.role === "system") {
				return message.tools;
			}

			return [];
		},
	});

const tokenPatterns = [
	/Bearer [\w.~+/-]{20,}/u,
	/\bsk-[\w-]{20,}/u,
	/\beyJ[\w-]{10,}\.[\w-]{10,}/u,
	/\bsess-[\w-]{20,}/u,
];

const captures = [...Record.toEntries(requests), ...Record.toEntries(replies)];

const sealedIdentity = (text: string): Effect.Effect<void, CodexRequestRejected | CleanLaneRefused, Digest.Digest> =>
	Effect.gen(function* encodeSealed() {
		const request = yield* decoded(text);
		const pinned = yield* request.encode({ lane: "sealed", model: request.model, pinned: true });
		const bridged = yield* request.encode({ lane: "sealed", model: request.model, pinned: false });

		assert.strictEqual(pinned, text);
		assert.strictEqual(bridged, withBridge(text));
	});

const sealedModel = Effect.gen(function* sealedModel() {
	const request = yield* decoded(requests.customToolCall);
	const sent = yield* request.encode({ lane: "sealed", model: realModel, pinned: false });

	assert.strictEqual(request.model, "phi/auto");
	assert.strictEqual(sent, withBridge(withRealModel(requests.customToolCall)));
});

const cleanModel = Effect.gen(function* cleanModel() {
	const request = yield* decoded(requests.firstTurn);
	const sent = yield* cleanBody(request);

	assert.deepStrictEqual([sent.model, sent.instructions], [realModel, bridgesFor.codex]);
});

const dialect = (text: string, tools: number): Effect.Effect<void, CodexRequestRejected, Digest.Digest> =>
	Effect.gen(function* readDialect() {
		const { messages } = yield* decoded(text);

		assert.lengthOf(firstTools(messages), tools);
	});

const refused = (text: string, path: string): Effect.Effect<void, CodexRequest, Digest.Digest> =>
	Effect.gen(function* refuse() {
		const error = yield* Effect.flip(decoded(text));

		assert.isTrue(Predicate.isTagged(error, "CodexRequestRejected"));
		assert.include(error.reason, path);
		assert.notInclude(error.reason, canary);
	});

const image = '{"type":"input_image","image_url":"https://example.com/scan.png"},';

const unreadPart = Effect.gen(function* unreadPart() {
	const text = Str.replace(
		'{"type":"input_text","text":"Run the shell',
		`${image}{"type":"input_text","text":"Run the shell`,
	)(requests.firstTurn);

	const request = yield* decoded(text);
	const sent = yield* cleanBody(request);
	const original = yield* sentOf(withBridge(requests.firstTurn));
	const stubbed = [{ text: stubs.unknown, type: "input_text" }];

	const expected = pipe(
		original.input,
		Array.map(({ content }) => content),
		Array.matchRight({ onEmpty: () => [], onNonEmpty: (before) => [...before, stubbed] }),
	);

	assert.deepStrictEqual(
		pipe(
			sent.input,
			Array.map(({ content }) => content),
		),
		expected,
	);
});

const writersOf = (messages: readonly Message[]): readonly string[] =>
	pipe(
		messages,
		Array.flatMap((message) => {
			if (message.role === "assistant") {
				return [message.writtenBy];
			}

			return [];
		}),
	);

const reasoning = Effect.gen(function* reasoning() {
	const writtenRequest = yield* decodedAfter(requests.customToolCall, replies.customToolCallReply);
	const otherRequest = yield* decoded(requests.customToolCall);
	const written = yield* cleanOf(writtenRequest, allCleared);
	const other = yield* cleanOf(otherRequest, allCleared);

	assert.deepStrictEqual(writersOf(writtenRequest.messages), ["open-account"]);
	assert.deepStrictEqual(writersOf(otherRequest.messages), ["other"]);
	assert.strictEqual(written, withBridge(withRealModel(requests.customToolCall)));
	const withoutReasoning = Str.replace(reasoningItem, "")(requests.customToolCall);

	assert.strictEqual(other, withBridge(withRealModel(withoutReasoning)));
});

const carriesBlob = ({ arguments: args = "" }: typeof SentItem.Type): boolean => Str.includes("gAAAAA")(args);

const blobs = Effect.gen(function* blobs() {
	const unwritten = yield* Effect.flatMap(decoded(requests.subagent), (request) => cleanOf(request, allCleared));

	const written = yield* Effect.flatMap(decodedAfter(requests.subagent, replies.spawnReply), (request) =>
		cleanOf(request, allCleared),
	);

	const parent = yield* decodedAfter(requests.subagentParent, replies.spawnReply);
	const sent = yield* cleanBody(parent);

	const spawns = pipe(
		sent.input,
		Array.filter(({ type }) => type === "function_call"),
		Array.map(carriesBlob),
	);

	assert.deepStrictEqual(
		{ spawns, unwritten: Str.includes("gAAAAA")(unwritten), written: Str.includes("gAAAAA")(written) },
		{ spawns: [false, true, false], unwritten: false, written: true },
	);
});

const refusals = [
	['["instructions"]', Str.replace('{"model":', `{"instructions":"${canary}","model":`)(requests.firstTurn)],
	[
		'["future_field"]',
		Str.replace('"stream":true,', `"stream":true,"future_field":{"note":"${canary}"},`)(requests.firstTurn),
	],
	['["model"]', Str.replace('{"model":"phi/auto"', `{"model":["${canary}"]`)(requests.firstTurn)],
	[
		"first field",
		Str.replace('{"model":"phi/auto","stream":true,', '{"stream":true,"model":"phi/auto",')(requests.firstTurn),
	],
	["named twice", Str.replace('"stream":true,', '"stream":true,"model":"phi/auto",')(requests.firstTurn)],
	["object", `["${canary}"]`],
	["valid JSON", canary],
] as const;

const encodeQuoted = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

const lastAsk = '"Run the shell command `cat notes.txt` once, then reply with exactly its output."';

const anyTextIdentity = ({
	text,
}: {
	readonly text: string;
}): Effect.Effect<void, CodexRequestRejected | CleanLaneRefused, Digest.Digest> =>
	Effect.gen(function* encodeAnyText() {
		const quoted = yield* Effect.orDie(encodeQuoted(text));
		const request = pipe(Str.split(requests.firstTurn, lastAsk), Array.join(quoted));

		assert.notStrictEqual(request, requests.firstTurn);

		yield* sealedIdentity(request);
	});

const bigNumber = Str.replace('"parameters":{', '"parameters":{"maximum":9007199254740993,')(requests.functionCall);

const tokenFree = (text: string): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const pattern of tokenPatterns) {
			assert.notMatch(text, pattern);
		}
	});

const misaligned = Effect.gen(function* misaligned() {
	const request = yield* decoded(requests.firstTurn);
	const messages = [...request.messages, ...request.messages];
	const exit = yield* Effect.exit(request.encode({ lane: "clean", messages, model: realModel }));

	assert.isTrue(Exit.hasDies(exit));
});

const partKindOf = (message: Message): string => {
	if (message.role !== "system") {
		return message.role;
	}

	if (message.content === "" && Array.isReadonlyArrayEmpty(message.sections)) {
		return "tools";
	}

	return "system";
};

const partKinds = Effect.gen(function* partKinds() {
	const custom = yield* decoded(requests.customToolCall);
	const parent = yield* decoded(requests.subagentParent);
	const developerMessages = ["system", "system", "system", "system"];

	assert.deepStrictEqual(
		{ custom: pipe(custom.messages, Array.map(partKindOf)), parent: pipe(parent.messages, Array.map(partKindOf)) },
		{
			custom: ["tools", ...developerMessages, "user", "user", "assistant", "toolResult", "tools"],
			parent: [
				"tools",
				...developerMessages,
				"user",
				"user",
				"assistant",
				"toolResult",
				"assistant",
				"toolResult",
				"assistant",
				"toolResult",
				"user",
				"tools",
			],
		},
	);
});

const withoutMessageId = Str.replace(/"id":"msg_0dfca2[^"]*",/u, "");

const unidentified = Effect.gen(function* unidentified() {
	const request = yield* decodedAfter(withoutMessageId(requests.customToolCall), replies.customToolCallReply);

	assert.deepStrictEqual(writersOf(request.messages), ["other"]);
});

it.layer(Digest.layerWebCrypto)("Codex codec", (test) => {
	test.effect.each(captures)("%s holds nothing shaped like a token", ([, text]) => tokenFree(text));
	test.effect.each(Record.toEntries(requests))("the sealed lane gets %s byte for byte but the bridge", ([, text]) =>
		sealedIdentity(text),
	);
	test.effect("the sealed lane keeps a number past 2^53 as Codex wrote it", () => sealedIdentity(bigNumber));
	test.effect.prop("decode then encode keeps any user text byte for byte", { text: Schema.String }, anyTextIdentity);
	test.effect(
		"a request's model is the one Codex named, and the sealed lane gets only it changed and the bridge added",
		() => sealedModel,
	);
});

it.layer(Digest.layerWebCrypto)("Codex codec rules", (test) => {
	test.effect("the clean lane gets the real model slug and the bridge", () => cleanModel);
	test.effect("the lite dialect's tool list is the first message", () => dialect(requests.firstTurn, liteTools));
	test.effect("the fallback dialect's tool list is the first message", () =>
		dialect(requests.functionCall, fallbackTools),
	);
	test.effect.each(refusals)("a body is refused with a reason that names %s and no value it holds", ([path, text]) =>
		refused(text, path),
	);
	test.effect("a part the codec cannot read goes to the clean lane as the stub, though cleared", () => unreadPart);
	test.effect("reasoning the clean lane wrote stays on the clean lane, and any other goes", () => reasoning);
	test.effect("a blob outside reasoning is unjudged unless a clean-lane reply wrote it", () => blobs);
	test.effect("a clean body asked for messages that do not line up with the request's parts dies", () => misaligned);
	test.effect(
		"each item reads as one message: a developer message as system, a user or agent message as user, a tool output as a tool result, a reply's run as one assistant message, and the tool list as tools alone",
		() => partKinds,
	);
	test.effect(
		"a reply's run with an item that has no id is not the open account's, though a clean-lane reply wrote it",
		() => unidentified,
	);
});
