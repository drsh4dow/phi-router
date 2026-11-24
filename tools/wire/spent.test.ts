import { Array, Effect, Option } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { costOf, tokensIn } from "./spent.ts";

const claudeResult = Array.join(
	[
		'{"type":"system","subtype":"init","session_id":"s1"}',
		'{"type":"result","subtype":"success","result":"ok","usage":{"input_tokens":3,"cache_creation_input_tokens":5,"cache_read_input_tokens":11,"output_tokens":13}}',
	],
	"\n",
);

const codexEvents = Array.join(
	[
		'{"type":"thread.started","thread_id":"t1"}',
		'{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":7}}',
		'{"type":"turn.completed","usage":{"input_tokens":20,"cached_input_tokens":0,"output_tokens":1}}',
	],
	"\n",
);

const piEvents = Array.join(
	[
		'{"type":"message_end","message":{"role":"user","content":"Reply with the single word ok."}}',
		'{"type":"message_end","message":{"role":"assistant","usage":{"input":2,"output":3,"cacheRead":5,"cacheWrite":7,"totalTokens":17}}}',
		'{"type":"message_end","message":{"role":"assistant","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2}}}',
	],
	"\n",
);

const read = Effect.sync(() => {
	assert.deepStrictEqual(
		[tokensIn.claude(claudeResult), tokensIn.codex(codexEvents), tokensIn.pi(piEvents)],
		[
			{ cacheRead: 11, cacheWrite: 5, output: 13, uncachedInput: 3 },
			{ cacheRead: 40, cacheWrite: 0, output: 8, uncachedInput: 80 },
			{ cacheRead: 5, cacheWrite: 7, output: 4, uncachedInput: 3 },
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

describe("what a turn on a BAA account spent", () => {
	it.effect(
		"is read from the tokens each harness prints, with Codex's cached tokens taken out of its input",
		() => read,
	);
	it.effect(
		"costs pi's listed base price per million tokens of each kind, and nothing known on a model with no price",
		() => priced,
	);
});
