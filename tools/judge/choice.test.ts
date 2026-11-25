import { Effect, Record, Schema, Struct, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { judgeFrom, mockOn } from "./configured.ts";
import type { Json } from "#router/client/mock-upstreams/index.ts";
import { NodeServices } from "@effect/platform-node";
import type { ScoreQuestion } from "#router/client/judge/index.ts";
import { sealingWhen } from "#router/client/mock-upstreams/index.ts";

const scoreQuestion: ScoreQuestion = { criteria: { false: "F", true: "T" }, instructions: "Is it so?", type: "bool" };

const input = { context: [], images: [], piece: "p" };

const none = 0;

const once = 1;

const keyed = (vendor: "anthropic" | "openai", name: string, endpoint: string): Json => ({
	endpoint,
	keyEnv: "PHI_TEST_KEY",
	name,
	scheme: "apiKey",
	vendor,
});

const lanes = (sealed: readonly Json[], beside: Readonly<Record<string, Json>> = {}): Json =>
	Struct.assign(beside, {
		clean: [
			{ forwarded: true, name: "open", vendor: "anthropic" },
			{ forwarded: true, name: "open-openai", vendor: "openai" },
		],
		sealed,
		targetModel: { anthropic: "target", openai: "target" },
	});

const callsOf = Effect.fnUntraced(function* callsOf(
	file: (endpoints: { readonly first: string; readonly second: string }) => Json,
) {
	const first = yield* mockOn(sealingWhen(() => true));
	const second = yield* mockOn(sealingWhen(() => true));
	const judge = yield* judgeFrom(file({ first: first.endpoint, second: second.endpoint }));

	yield* judge.identifier(input, scoreQuestion);

	const received = yield* Effect.all({ first: first.received, second: second.received }, { concurrency: 1 });

	return pipe(
		received,
		Record.map((calls) => calls.length),
	);
});

const sealedOpenAi = Effect.gen(function* sealedOpenAi() {
	const calls = yield* callsOf(({ first, second }) =>
		lanes([keyed("anthropic", "a", second), keyed("openai", "o", first)]),
	);

	assert.deepStrictEqual(calls, { first: once, second: none });
});

const judgeBlock = Effect.gen(function* judgeBlock() {
	const calls = yield* callsOf(({ first, second }) =>
		lanes([keyed("openai", "o", second)], { judge: { endpoint: first, keyEnv: "PHI_TEST_KEY" } }),
	);

	assert.deepStrictEqual(calls, { first: once, second: none });
});

const noOpenAiKey = Effect.gen(function* noOpenAiKey() {
	const file = lanes([
		keyed("anthropic", "baa", "https://api.anthropic.com"),
		{ forwarded: true, name: "forwarded", vendor: "openai" },
		{ loginFolder: "/nonexistent", name: "openai-folder", vendor: "openai" },
	]);

	const failed = yield* Effect.flip(judgeFrom(file));

	assert.include(failed.message, "Run phi-router setup.");
});

const namedModel = Effect.gen(function* namedModel() {
	const failed = yield* Effect.flip(
		judgeFrom({ judge: { endpoint: "https://api.openai.com/v1", keyEnv: "PHI_TEST_KEY", model: "gpt-6-sol" } }),
	);

	assert.instanceOf(failed, Schema.SchemaError);
	assert.include(failed.message, '["judge"]["model"]');
});

it.layer(NodeServices.layer)("the judge config.json names", (test) => {
	test.effect(
		"is the first OpenAI API-key account on sealed, though an Anthropic account comes first",
		() => sealedOpenAi,
	);
	test.effect("is the judge block, with its own key, ahead of an OpenAI API-key account on sealed", () => judgeBlock);
	test.effect(
		"is none with no judge block and no OpenAI API-key account on sealed, and the router names phi-router setup",
		() => noOpenAiKey,
	);
	test.effect("is none when the judge block names a model, and the error names the field", () => namedModel);
});
