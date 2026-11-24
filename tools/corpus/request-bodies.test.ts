import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { messagesOf } from "./request-bodies.ts";

it.effect("a body that is no JSON is one message, and each element of an array body is its own message", () =>
	Effect.sync(() => {
		assert.deepStrictEqual(messagesOf("The id is MRN 4417-2290."), [["The id is MRN 4417-2290."]]);

		assert.deepStrictEqual(messagesOf('[{"content":"MRN 4417-"},{"content":"2290"}]'), [["MRN 4417-"], ["2290"]]);
	}),
);
