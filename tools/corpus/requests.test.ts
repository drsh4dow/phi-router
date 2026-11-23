import { Array, Effect, Option, String as Str, pipe } from "effect";
import type { Case, Part, Transcript } from "./manifest.ts";
import { assert, describe, it } from "@effect/vitest";
import { identifierKind } from "#router/features/policy/index.ts";
import { requestsOf } from "./requests.ts";

const textOf = (part: Part): string => {
	if (part.kind === "text") {
		return part.text;
	}

	return "";
};

const texts = (request: Transcript): readonly (readonly string[])[] =>
	pipe(
		request,
		Array.map(({ role, parts }) => [
			role,
			...pipe(
				parts,
				Array.map((part) => textOf(part)),
			),
		]),
	);

const wrapped = (summary: string): string =>
	`The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`;

const fetchedTwice: Case = {
	canaries: ["canary-fetch"],
	expect: "phi",
	fragments: [],
	id: "fetch",
	messages: [
		{ role: "user", text: "Why is this note rejected?" },
		{ role: "assistant", text: "Fetching it." },
		{ role: "tool", text: "Line one" },
		{ role: "assistant", text: "Cut off. Fetching the rest." },
		{ role: "tool", text: "Line two" },
	],
	strata: {
		carrier: "clinical-note",
		entry: "tool-result",
		identifier: identifierKind.driverLicense,
		transform: "split",
	},
};

const compactedTwice: Case = {
	canaries: [],
	expect: "clean",
	fragments: [],
	id: "twice",
	messages: [
		{ role: "user", text: "Why does the importer skip rows?" },
		{ role: "assistant", text: "Reading it." },
		{ role: "tool", text: "src/import.ts:12: if (!row.id) continue" },
		{ role: "user", text: wrapped("First summary.") },
		{ role: "user", text: wrapped("Second summary.") },
		{ role: "user", text: "Keep going." },
	],
	strata: { negative: "schema-only" },
};

const toolResults = Effect.gen(function* toolResults() {
	const requests = yield* requestsOf(fetchedTwice);

	assert.deepStrictEqual(
		pipe(
			requests,
			Array.map((request) => texts(request)),
		),
		[
			[["user", "Why is this note rejected?"]],
			[
				["user", "Why is this note rejected?"],
				["assistant", "Fetching it.", 'bash toolu_mock_1 {"command":"cat files/2.txt"}'],
				["tool", "toolu_mock_1", "Line one"],
			],
			[
				["user", "Why is this note rejected?"],
				["assistant", "Fetching it.", 'bash toolu_mock_1 {"command":"cat files/2.txt"}'],
				["tool", "toolu_mock_1", "Line one"],
				["assistant", "Cut off. Fetching the rest.", 'bash toolu_mock_2 {"command":"cat files/4.txt"}'],
				["tool", "toolu_mock_2", "Line two"],
			],
		],
	);
});

const compactions = Effect.gen(function* compactions() {
	const requests = yield* requestsOf(compactedTwice);
	const last = texts(Option.getOrElse(Array.last(requests), () => []));

	assert.deepStrictEqual(
		Array.head(last),
		Option.some(["user", wrapped("Second summary.\n\n<read-files>\nfiles/2.txt\n</read-files>")]),
	);

	assert.isFalse(
		pipe(
			last,
			Array.some((turn) =>
				pipe(
					turn,
					Array.some((said) => Str.includes("First summary")(said)),
				),
			),
		),
	);

	assert.deepStrictEqual(Array.last(last), Option.some(["user", "Keep going."]));
});

describe("the requests a case's pi sends", () => {
	it.effect(
		"a tool result shares its request with the assistant turn that called it, rendered as pi sends them",
		() => toolResults,
	);

	it.effect("a second compaction's summary replaces the first and lists the files read before it", () => compactions);
});
