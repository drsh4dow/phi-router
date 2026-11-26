import { Array, Effect, Predicate, String as Str, pipe } from "effect";
import type { Harness, Keep } from "./index.ts";
import type { Lookup, Standing } from "#router/features/verdicts/index.ts";
import type { Message, Part } from "#router/features/parts/index.ts";
import { ToolsNotCleared, guard, sealedStub } from "./index.ts";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import { handleAt } from "#router/primitives/handle.ts";
import { partsOf } from "#router/features/parts/index.ts";
import { stubs } from "#router/features/policy/index.ts";

const firstSequence = 1;

const h1 = handleAt(firstSequence);

const secondSequence = 2;

const h2 = handleAt(secondSequence);

const asked: Message = {
	content: [{ text: "Why does the eligibility import drop row 88123?", type: "text" }],
	role: "user",
};

const pasted: Message = {
	content: [
		{ text: "Member Canary Fakesmith, DOB 1900-01-01", type: "text" },
		{ data: "c2Nhbg==", mimeType: "image/png", type: "image" },
	],
	role: "user",
};

const answer: Message = {
	content: [
		{ text: "Reading the file.", type: "text" },
		{ arguments: '{"path":"fixtures/adt.hl7"}', id: "toolu_7", name: "read", type: "toolCall" },
	],
	role: "assistant",
	writtenBy: "other",
};

const read: Message = {
	content: [{ text: "PID|1||MRN-55120||FAKESMITH^CANARY||19000101", type: "text" }],
	isError: false,
	role: "toolResult",
	toolCallId: "toolu_7",
};

const prompt: Message = {
	content: "You are a coding agent.",
	role: "system",
	sections: [
		{ name: "project", text: "Ward 4 census: Canary Fakesmith" },
		{ name: "style", text: "Answer briefly." },
	],
	tools: [{ description: "Read a file", name: "read", parameters: '{"type":"object","properties":{}}' }],
};

const inOrder: Keep<never> = (parts) =>
	pipe(
		parts,
		Array.map(({ key }, index) => [key, handleAt(index + firstSequence)] as const),
		(pairs) => new Map(pairs),
		Effect.succeed,
	);

const lookupOf = Effect.fnUntraced(function* lookupOf(
	given: readonly (readonly [Standing, readonly Message[]])[],
	held: (slot: Part["slot"]) => boolean = (): boolean => false,
) {
	const known = new Map<string, Standing>();

	for (const [standing, messages] of given) {
		for (const message of messages) {
			for (const { key, slot } of yield* partsOf(message)) {
				if (!held(slot)) {
					known.set(key, standing);
				}
			}
		}
	}

	const lookup: Lookup = (key) => known.get(key) ?? "unknown";

	return lookup;
});

const passes = Effect.gen(function* passes() {
	const messages = [prompt, asked, pasted, answer, read];
	const lookup = yield* lookupOf([["cleared", messages]]);
	const sent = yield* guard({ harness: "claude", keep: inOrder, lookup, messages });

	assert.deepStrictEqual(sent, messages);
});

const stubbed = Effect.gen(function* stubbed() {
	const lookup = yield* lookupOf([
		["sealed", [pasted, read]],
		["cleared", [asked]],
	]);

	const sent = yield* guard({ harness: "claude", keep: inOrder, lookup, messages: [asked, pasted, answer, read] });

	assert.deepStrictEqual(sent, [
		asked,
		{ content: [{ text: sealedStub("claude")(h1), type: "text" }], role: "user" },
		{
			content: [
				{ text: stubs.unknown, type: "text" },
				{ arguments: "{}", id: "toolu_7", name: "read", type: "toolCall" },
			],
			role: "assistant",
			writtenBy: "other",
		},
		{
			content: [{ text: sealedStub("claude")(h2), type: "text" }],
			isError: false,
			role: "toolResult",
			toolCallId: "toolu_7",
		},
	]);
});

const perHarness = Effect.gen(function* perHarness() {
	const lookup = yield* lookupOf([["sealed", [read]]]);
	const harnesses = ["claude", "codex", "pi"] as const satisfies readonly Harness[];

	const sent = yield* Effect.forEach(
		harnesses,
		(harness) => guard({ harness, keep: inOrder, lookup, messages: [read] }),
		{
			concurrency: 1,
		},
	);

	const stubOf = (harness: (typeof harnesses)[number]): readonly Message[] => [
		{
			content: [{ text: sealedStub(harness)(h1), type: "text" }],
			isError: false,
			role: "toolResult",
			toolCallId: "toolu_7",
		},
	];

	const harnessStubs = pipe(
		harnesses,
		Array.map((harness) => sealedStub(harness)(h1)),
	);

	const tagged = pipe(harnessStubs, Array.every(Str.startsWith("[sealed h1] ")));

	assert.deepStrictEqual(sent, pipe(harnesses, Array.map(stubOf)));
	assert.isTrue(tagged);
	assert.strictEqual(new Set(harnessStubs).size, harnesses.length);
});

const section = Effect.gen(function* section() {
	const lookup = yield* lookupOf(
		[["cleared", [prompt]]],
		(slot) => Predicate.isTagged(slot, "SystemSection") && slot.name === "project",
	);

	const sent = yield* guard({ harness: "codex", keep: inOrder, lookup, messages: [prompt] });

	assert.deepStrictEqual(sent, [
		{
			content: "You are a coding agent.",
			role: "system",
			sections: [
				{ name: "project", text: stubs.unknown },
				{ name: "style", text: "Answer briefly." },
			],
			tools: [{ description: "Read a file", name: "read", parameters: '{"type":"object","properties":{}}' }],
		},
	]);
});

const refused = Effect.gen(function* refused() {
	const lookup = yield* lookupOf([["cleared", [prompt, asked]]], Predicate.isTagged("SystemTools"));
	const refusal = yield* Effect.flip(guard({ harness: "pi", keep: inOrder, lookup, messages: [prompt, asked] }));

	assert.instanceOf(refusal, ToolsNotCleared);
});

it.layer(Digest.layerWebCrypto)("guard", (test) => {
	test.effect("cleared user, tool and reply parts pass as they are", () => passes);
	test.effect("sealed and never-judged parts become stubs that keep only roles, ids and tool names", () => stubbed);
	test.effect("each harness gets its own sealed stub, which opens with the part's handle", () => perHarness);
	test.effect(
		"an uncleared system section is stubbed while the content, other sections and tools pass",
		() => section,
	);
	test.effect("tools that never cleared refuse the request", () => refused);
});
