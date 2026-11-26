import { Array, Effect, Option } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { costOf, usageIn } from "./spent.ts";

const anthropicStream = Array.join(
	[
		"event: message_start",
		'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_creation_input_tokens":5,"cache_read_input_tokens":11,"output_tokens":1}}}',
		"",
		"event: message_delta",
		'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":13}}',
	],
	"\n",
);

const openAiStream = Array.join(
	[
		'data: {"type":"response.created","response":{"status":"in_progress"}}',
		'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":40},"output_tokens":7}}}',
	],
	"\n",
);

const read = Effect.sync(() => {
	assert.deepStrictEqual(
		[usageIn(anthropicStream), usageIn(openAiStream), usageIn('{"type":"error"}')],
		[
			{ read: true, tokens: { cacheRead: 11, cacheWrite: 5, output: 13, uncachedInput: 3 } },
			{ read: true, tokens: { cacheRead: 40, cacheWrite: 0, output: 7, uncachedInput: 60 } },
			{ read: false },
		],
	);
});

const millions = { cacheRead: 3_000_000, cacheWrite: 4_000_000, output: 2_000_000, uncachedInput: 1_000_000 };

const millionsInDollars = 1.63;

const priced = Effect.sync(() => {
	assert.deepStrictEqual(
		[
			costOf({ model: "claude-haiku-5-5", tokens: millions }),
			costOf({ model: "gpt-6-luna", tokens: millions }),
			costOf({ model: "claude-unpriced", tokens: millions }),
		],
		[Option.some(millionsInDollars), Option.some(millionsInDollars), Option.none()],
	);
});

describe("what a request to a BAA account spent", () => {
	it.effect(
		"is read from the usage the account answered with, the last count of each kind, with OpenAI's cached tokens taken out of its input",
		() => read,
	);
	it.effect(
		"costs pi's listed base price per million tokens of each kind, and nothing known on a model with no price",
		() => priced,
	);
});
