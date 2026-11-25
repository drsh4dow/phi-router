import { Array, Effect, Option, Struct, pipe } from "effect";
import type { AssistantMessage, Message, Part, ToolResultMessage } from "./index.ts";
import { assert, it } from "@effect/vitest";
import { partsOf, piecesOf } from "./index.ts";
import { Digest } from "effect/crypto";
import { stubs } from "#router/features/policy/index.ts";

const reply = (writtenBy: AssistantMessage["writtenBy"], content: AssistantMessage["content"]): AssistantMessage => ({
	content,
	role: "assistant",
	writtenBy,
});

const readCall = {
	arguments: '{"path":"notes/admissions.csv"}',
	id: "toolu_1",
	name: "read",
	type: "toolCall",
} as const;

const result = (text: string, toolCallId = "toolu_1"): ToolResultMessage => ({
	content: [{ text, type: "text" }],
	isError: false,
	role: "toolResult",
	toolCallId,
});

const asked = (text: string): Message => ({ content: [{ text, type: "text" }], role: "user" });

const keyOf = (message: Message): Effect.Effect<readonly Part["key"][], never, Digest.Digest> =>
	pipe(partsOf(message), Effect.map(Array.map(({ key }) => key)));

it.layer(Digest.layerWebCrypto)("partsOf keys", (test) => {
	test.effect("a tool result read again under a new tool call id keeps its key, and new text changes it", () =>
		Effect.gen(function* rereadResult() {
			const first = yield* keyOf(result("id,name\n4471,asthma"));
			const again = yield* keyOf(result("id,name\n4471,asthma", "toolu_9"));
			const changed = yield* keyOf(result("id,name\n4472,asthma"));

			assert.deepStrictEqual(again, first);
			assert.notDeepEqual(changed, first);
		}),
	);

	test.effect("a tool result as the wire hands it keeps its key under a new tool call id and timestamp", () =>
		Effect.gen(function* wireResult() {
			const first = Struct.assign(result("id,name\n4471,asthma"), { timestamp: "2026-11-20T10:00:00Z" });

			const again = Struct.assign(result("id,name\n4471,asthma", "toolu_9"), {
				timestamp: "2026-11-20T10:05:00Z",
			});

			const firstKey = yield* keyOf(first);
			const againKey = yield* keyOf(again);

			assert.deepStrictEqual(againKey, firstKey);
		}),
	);

	test.effect("a failed tool result and a successful one with the same text get different keys", () =>
		Effect.gen(function* failedResult() {
			const succeeded = yield* keyOf(result("sync failed at step 3"));
			const failed = yield* keyOf(Struct.assign(result("sync failed at step 3"), { isError: true }));

			assert.notDeepEqual(failed, succeeded);
		}),
	);

	test.effect("a reply retried under another account keeps its key, and new text changes it", () =>
		Effect.gen(function* retriedReply() {
			const first = yield* keyOf(reply("open-account", [{ text: "Reading.", type: "text" }, readCall]));
			const retried = yield* keyOf(reply("other", [{ text: "Reading.", type: "text" }, readCall]));
			const changed = yield* keyOf(reply("open-account", [{ text: "Reading now.", type: "text" }, readCall]));

			assert.deepStrictEqual(retried, first);
			assert.notDeepEqual(changed, first);
		}),
	);
});

it.layer(Digest.layerWebCrypto)("partsOf slots", (test) => {
	test.effect("a system message gives a content part, a part per section and a tools part", () =>
		Effect.gen(function* systemParts() {
			const parts = yield* partsOf({
				content: "You are a coding agent.",
				role: "system",
				sections: [{ name: "project", text: "<project>phi-router</project>" }],
				tools: [{ description: "Read a file", name: "read", parameters: '{"type":"object"}' }],
			});

			const tags = pipe(
				parts,
				Array.map(({ slot: { _tag: tag } }) => tag),
			);

			const slotNames = pipe(
				parts,
				Array.flatMap(({ slot }) => {
					if ("name" in slot) {
						return [slot.name];
					}

					return [];
				}),
			);

			const keys = new Set(
				pipe(
					parts,
					Array.map(({ key }) => key),
				),
			);

			assert.deepStrictEqual(tags, ["SystemContent", "SystemSection", "SystemTools"]);
			assert.deepStrictEqual(slotNames, ["project"]);
			assert.strictEqual(keys.size, parts.length);
		}),
	);
});

const twoTurns = [
	asked("Why do admissions fail?"),
	reply("other", [{ text: "Checking.", type: "text" }]),
	asked("Look again."),
	reply("open-account", [readCall]),
	result("id,name\n4471,asthma"),
];

const sealedAsk = asked("Look up member 9001, ssn 523-61-1234.");

const sealedRead = reply("other", [readCall]);

const sealedCut = result("member 9001, ssn 523-61-12", "toolu_3");

const cutExport = [
	asked("Read the export."),
	result("member 4471, ssn 412-56-78"),
	result("23, plan gold", "toolu_2"),
	asked("thanks"),
	result(" next page.\n", "toolu_4"),
	sealedCut,
	result("34, plan silver", "toolu_5"),
];

it.layer(Digest.layerWebCrypto)("piecesOf context", (test) => {
	test.effect("a tool result's context starts with its own tool call", () =>
		Effect.gen(function* ownCall() {
			const messages = [
				asked("Why do admissions fail?"),
				reply("open-account", [readCall]),
				result("id,name\n4471,asthma"),
			];

			const pieces = yield* piecesOf({ messages, window: 1 });

			assert.deepStrictEqual(
				pipe(
					Array.last(pieces),
					Option.map(({ context }) => context),
				),
				Option.some(['[tool call] read({"path":"notes/admissions.csv"})']),
			);
		}),
	);

	test.effect("a sealed message and its tool calls reach later context only as the stub, nearest first", () =>
		Effect.gen(function* sealedContext() {
			const sealedKeys = new Set([...(yield* keyOf(sealedAsk)), ...(yield* keyOf(sealedRead))]);

			const pieces = yield* piecesOf({
				messages: [sealedAsk, sealedRead, result("id,name\n4471,asthma")],
				sealed: (key) => sealedKeys.has(key),
				window: 3,
			});

			assert.deepStrictEqual(
				pipe(
					Array.last(pieces),
					Option.map(({ context }) => context),
				),
				Option.some([`[tool call] ${stubs.sealed}`, `[assistant] ${stubs.sealed}`, `[user] ${stubs.sealed}`]),
			);
		}),
	);

	test.effect(
		"a message that goes on mid-word from the last one of its role is judged with that one's end, and others are not",
		() =>
			Effect.gen(function* seams() {
				const sealedKeys = yield* keyOf(sealedCut);

				const pieces = yield* piecesOf({
					messages: cutExport,
					sealed: (key) => sealedKeys.includes(key),
					window: 1,
				});

				assert.deepStrictEqual(
					pipe(
						pieces,
						Array.map(({ seam }) => seam.text),
					),
					["", "", "member 4471, ssn 412-56-78", "", "", "", ""],
				);
			}),
	);
});

it.layer(Digest.layerWebCrypto)("piecesOf kinds", (test) => {
	test.effect("replies are open only from an open account", () =>
		Effect.gen(function* kinds() {
			const pieces = yield* piecesOf({ messages: twoTurns });

			assert.deepStrictEqual(
				pipe(
					pieces,
					Array.map(({ kind }) => kind),
				),
				["user", "reply-other", "user", "reply-open", "tool-result"],
			);
		}),
	);
});
