import { Effect, Schema } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { decodeJsonLines } from "./jsonl.ts";

const text = '"fine"\n\nnot json\nalso not json\n';

const editorLineOfNotJson = 3;

const firstBadLine = Effect.gen(function* firstBadLine() {
	const failure = yield* Effect.flip(
		decodeJsonLines({ schema: Schema.fromJsonString(Schema.String), source: "texts.jsonl", text }),
	);

	assert.strictEqual(failure.line, editorLineOfNotJson);
});

describe("decoding JSON lines", () => {
	it.effect(
		"skips blank lines and fails on the first bad one with the line number an editor shows",
		() => firstBadLine,
	);
});
