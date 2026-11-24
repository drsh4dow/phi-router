import { Array, Effect, Predicate, String as Str, pipe } from "effect";
import type { CleanLaneRefused, CodexRequest, CodexRequestRejected } from "./index.ts";
import { assert, it } from "@effect/vitest";
import { cleanLaneKeys, decodeRequest } from "./index.ts";
import { replies, requests } from "./captures/index.ts";
import { Digest } from "effect/crypto";
import type { Lookup } from "#router/features/verdicts/index.ts";
import type { ToolsNotCleared } from "#router/features/border/index.ts";
import { guard } from "#router/features/border/index.ts";

const realModel = "gpt-5.5";

const allCleared: Lookup = () => "cleared";

const cleanBodyPastBorder = (
	request: Pick<CodexRequest, "encode" | "messages">,
	lookup: Lookup,
): Effect.Effect<string, CleanLaneRefused | ToolsNotCleared, Digest.Digest> =>
	Effect.flatMap(guard({ harness: "codex", lookup, messages: request.messages }), (messages) =>
		request.encode({ lane: "clean", messages, model: realModel }),
	);

const blob = "gAAAAABtool-description-blob-0001";

const blobReply = `data: {"type":"response.output_item.done","item":{"id":"msg_1","content":"${blob}"}}
data: {"type":"response.completed"}`;

const withBlob = Str.replace('"description":"', `"description":"${blob} `);

const summaryItem = '"summary":[{"type":"summary_text","text":"Counting the lines of notes.txt"}]';

const withSummary = Str.replaceAll('"summary":[]', summaryItem);

const cleanAfter = (
	text: string,
	reply: string,
): Effect.Effect<string, CodexRequestRejected | CleanLaneRefused | ToolsNotCleared, Digest.Digest> =>
	Effect.gen(function* encodeAfter() {
		const keys = yield* cleanLaneKeys(reply);
		const written = new Set(keys);
		const request = yield* decodeRequest(text, (key) => written.has(key));

		return yield* cleanBodyPastBorder(request, allCleared);
	});

const withCallBlob = Str.replace('"name":"exec_command","arguments"', `"name":"${blob}","arguments"`);

const blobRefused = (
	text: string,
): Effect.Effect<void, CodexRequestRejected | CleanLaneRefused | ToolsNotCleared | string, Digest.Digest> =>
	Effect.gen(function* refuseBlob() {
		const error = yield* Effect.flip(cleanAfter(text, ""));
		const sent = yield* cleanAfter(text, blobReply);

		assert.isTrue(Predicate.isTagged(error, "CleanLaneRefused"));
		assert.include(sent, blob);
	});

const endedToo = [`${blobReply}\ndata: {"type":"response.failed"}`, `${blobReply}\ndata: {"type":"error"}`];

const unfinished = Effect.gen(function* unfinished() {
	const text = withBlob(requests.firstTurn);
	const cut = Str.replace('data: {"type":"response.completed"}', "")(blobReply);
	const failed = Str.replace("response.completed", "response.failed")(blobReply);
	const unfinishedReplies = [cut, failed, ...endedToo];

	const errors = yield* Effect.forEach(unfinishedReplies, (reply) => Effect.flip(cleanAfter(text, reply)), {
		concurrency: 1,
	});

	assert.notStrictEqual(cut, blobReply);
	assert.notStrictEqual(failed, blobReply);
	const refused = pipe(errors, Array.every(Predicate.isTagged("CleanLaneRefused")));

	assert.isTrue(refused);
});

const summaryWritten = Effect.gen(function* summaryWritten() {
	const text = withSummary(requests.customToolCall);
	const unwritten = yield* cleanAfter(text, replies.customToolCallReply);
	const written = yield* cleanAfter(text, withSummary(replies.customToolCallReply));

	assert.notInclude(unwritten, summaryItem);
	assert.notMatch(unwritten, /"type":"reasoning"/u);
	assert.include(written, summaryItem);
});

const withPlainReasoning = Str.replace(
	'"summary":[],"encrypted_content"',
	'"summary":[],"content":[{"type":"reasoning_text","text":"Counting the lines"}],"encrypted_content"',
);

const plainReasoning = Effect.gen(function* plainReasoning() {
	const text = withPlainReasoning(requests.customToolCall);
	const sent = yield* cleanAfter(text, replies.customToolCallReply);

	assert.notStrictEqual(text, requests.customToolCall);
	assert.notMatch(sent, /"type":"reasoning"/u);
});

const writersIn = Effect.fnUntraced(function* writersIn(text: string) {
	const keys = yield* cleanLaneKeys(replies.customToolCallReply);
	const written = new Set(keys);
	const { messages } = yield* decodeRequest(text, (key) => written.has(key));

	return pipe(
		messages,
		Array.flatMap((message) => {
			if (message.role === "assistant") {
				return [message.writtenBy];
			}

			return [];
		}),
	);
});

const echoed = Effect.gen(function* echoed() {
	const edited = Str.replace("I’ll run one shell command", "I’ll run two shell commands")(requests.resumed);
	const writers = yield* Effect.forEach([requests.resumed, edited], writersIn, { concurrency: 1 });

	assert.notStrictEqual(edited, requests.resumed);
	assert.deepStrictEqual(writers, [
		["open-account", "other"],
		["other", "other"],
	]);
});

it.layer(Digest.layerWebCrypto)("what the clean lane wrote", (test) => {
	test.effect.each([requests.firstTurn, requests.functionCall])(
		"a tool list with a blob no clean-lane reply wrote refuses the clean lane",
		(text) => blobRefused(withBlob(text)),
	);

	test.effect(
		"a reply that never completed, or failed beside its completion, wrote nothing the clean lane may get back",
		() => unfinished,
	);
	test.effect("reasoning goes unless a clean-lane reply wrote its summary too", () => summaryWritten);
	test.effect(
		"reasoning with plain reasoning text goes, though a clean-lane reply wrote its blob",
		() => plainReasoning,
	);
	test.effect(
		"Codex's echo of a completed reply is the open account's, and an edit under its item ids is not",
		() => echoed,
	);
	test.effect("a call name with a blob no clean-lane reply wrote refuses the clean lane", () =>
		blobRefused(withCallBlob(requests.functionCall)),
	);
});
