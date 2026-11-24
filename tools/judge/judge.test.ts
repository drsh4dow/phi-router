import { Array, Effect, Schema, Struct, pipe } from "effect";
import type { ChoiceQuestion, JudgeFailed, JudgeInput, ScoreQuestion } from "#router/client/judge/index.ts";
import { assert, it } from "@effect/vitest";
import { configuredJudge, mockedJudge } from "./configured.ts";
import { KeyUnreadable } from "#router/client/accounts/index.ts";
import type { Named } from "./configured.ts";
import { NodeServices } from "@effect/platform-node";
import type { Reply } from "#router/client/mock-upstreams/index.ts";

const fromEnv: Named = { keyEnv: "PHI_TEST_KEY", model: "judge-under-test" };

const scoreQuestion: ScoreQuestion = { criteria: { false: "F", true: "T" }, instructions: "Is it so?", type: "bool" };

const unsortedChoices: ChoiceQuestion<"zebra" | "apple" | "mango"> = {
	criteria: [
		["zebra", "Z"],
		["apple", "A"],
		["mango", "M"],
	],
	instructions: "Which one?",
	type: "choice",
};

const input: JudgeInput = { context: ["c"], images: [], piece: "p" };

const thousandTokens = { calls: 1, cost: 0.0001, inputTokens: 1000, ms: 0 };

const billed = { input_tokens: 1000, output_tokens: 1 };

const halfway: Reply = {
	body: { answers: [{ name: "identifier", probability: 0.5, type: "predicate" }], usage: billed },
	kind: "body",
};

const nowhere = "http://127.0.0.1:9/v1";

const sent = { bearer: "env-key", method: "POST", path: "/v1/decisions" } as const;

/** A well-formed answer to each question, beside two entries the judge must skip. */
const wellFormed = [
	{ name: "identifier", probability: 0.75, type: "predicate" },
	{
		choice: "apple",
		confidence: 1,
		name: "kind",
		probabilities: [{ probability: 1, value: "apple" }],
		type: "choice",
	},
	{ type: "unnamed" },
	{ name: "other", type: "unknown" },
];

const eachQuestion = Effect.gen(function* eachQuestion() {
	const { judge, mock } = yield* mockedJudge(
		() => ({ body: { answers: wellFormed, usage: billed }, kind: "body" }),
		fromEnv,
	);

	const score = yield* judge.identifier(input, scoreQuestion);
	const kind = yield* judge.kind(input, unsortedChoices);
	const received = yield* mock.received;

	const asked = pipe(received, Array.map(Struct.omit(["headers"])));

	assert.deepStrictEqual(asked, [
		Struct.assign(sent, {
			body: {
				input: '{"piece":"p","context":["c"]}',
				model: "judge-under-test",
				questions: [
					{ instructions: "Is it so?\n\nTrue means: T\nFalse means: F", name: "identifier", type: "predicate" },
				],
			},
		}),
		Struct.assign(sent, {
			body: {
				input: '{"piece":"p","context":["c"]}',
				model: "judge-under-test",
				questions: [
					{
						choices: [
							{ description: "Z", value: "zebra" },
							{ description: "A", value: "apple" },
							{ description: "M", value: "mango" },
						],
						instructions: "Which one?",
						name: "kind",
						type: "choice",
					},
				],
			},
		}),
	]);

	assert.deepStrictEqual(
		[score, kind],
		[
			{ score: 0.75, usage: thousandTokens },
			{ kind: "apple", usage: thousandTokens },
		],
	);
});

const configurations = [
	{
		field: "[0].body.model",
		name: "a file with no model sends the default",
		named: { keyEnv: "PHI_TEST_KEY" },
		value: "gpt-6-luna",
	},
	{
		field: "[0].bearer",
		name: "the key comes from the command the file names",
		named: { keyCommand: "printf command-key" },
		value: "command-key",
	},
] as const;

const configuration = Effect.fnUntraced(function* configuration({
	named,
	field,
	value,
}: (typeof configurations)[number]) {
	const { judge, mock } = yield* mockedJudge(() => halfway, named);

	yield* judge.identifier(input, scoreQuestion);

	const received = yield* mock.received;

	assert.nestedPropertyVal(received, field, value);
});

const sourceless = [
	{ name: "both key sources", named: { keyCommand: "printf command-key", keyEnv: "PHI_TEST_KEY" } },
	{ name: "neither key source", named: { model: "judge-under-test" } },
] as const;

const keyless = [
	{ name: "an unset variable", named: { keyEnv: "PHI_UNSET_KEY" }, source: "keyEnv PHI_UNSET_KEY" },
	{
		name: "a failing command",
		named: { keyCommand: "printf '%s-%s' sk 4242; exit 3" },
		source: "keyCommand printf '%s-%s' sk 4242; exit 3",
	},
	{ name: "a command that prints nothing", named: { keyCommand: "true" }, source: "keyCommand true" },
] as const;

const jsonOf = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const keyUnread = Effect.fnUntraced(function* keyUnread({ named, source }: (typeof keyless)[number]) {
	const failed = yield* Effect.flip(configuredJudge(nowhere, named));
	const shown = yield* jsonOf(failed);

	assert.instanceOf(failed, KeyUnreadable);
	assert.include(failed, { source });
	assert.notInclude(shown, "sk-4242");
});

const withImages = Effect.gen(function* withImages() {
	const { judge, mock } = yield* mockedJudge(() => halfway, fromEnv);

	const images = [
		{ data: "aW1n", mimeType: "image/png" },
		{ data: "anBn", mimeType: "image/jpeg" },
	];

	yield* judge.identifier({ context: [], images, piece: "p" }, scoreQuestion);

	const received = yield* mock.received;

	assert.deepNestedPropertyVal(received, "[0].body.input", [
		{
			content: [
				{ text: '{"piece":"p","context":[]}', type: "input_text" },
				{ image_url: "data:image/png;base64,aW1n", type: "input_image" },
				{ image_url: "data:image/jpeg;base64,anBn", type: "input_image" },
			],
			role: "user",
		},
	]);
});

const prices = [
	{ cost: 0.0001, inputTokens: 1000, reported: 1000 },
	{ cost: 0.0272, inputTokens: 272_000, reported: 272_000 },
	{ cost: 0.06, inputTokens: 300_000, reported: 300_000 },
	{ cost: 0, inputTokens: 0, reported: -5 },
] as const;

const priced = Effect.fnUntraced(function* priced({ cost, inputTokens, reported }: (typeof prices)[number]) {
	const answers = [{ name: "identifier", probability: 0.5, type: "predicate" }];
	const reply: Reply = { body: { answers, usage: { input_tokens: reported } }, kind: "body" };
	const { judge } = yield* mockedJudge(() => reply, fromEnv);
	const { usage } = yield* judge.identifier(input, scoreQuestion);

	assert.deepStrictEqual(usage, { calls: 1, cost, inputTokens, ms: 0 });
});

const failures: readonly {
	readonly name: string;
	readonly reply: Reply;
	readonly failed: Pick<JudgeFailed, "usage" | "why">;
}[] = [
	{
		failed: { usage: thousandTokens, why: "judge-error" },
		name: "a probability above 1",
		reply: {
			body: { answers: [{ name: "identifier", probability: 1.5, type: "predicate" }], usage: billed },
			kind: "body",
		},
	},
	{
		failed: { usage: thousandTokens, why: "judge-error" },
		name: "a probability below 0",
		reply: {
			body: { answers: [{ name: "identifier", probability: -1, type: "predicate" }], usage: billed },
			kind: "body",
		},
	},
	{
		failed: { usage: thousandTokens, why: "judge-error" },
		name: "no answer of the question's name",
		reply: {
			body: { answers: [{ name: "other", probability: 0.5, type: "predicate" }], usage: billed },
			kind: "body",
		},
	},
	{
		failed: { usage: thousandTokens, why: "judge-error" },
		name: "a choice answer to the score question",
		reply: {
			body: { answers: [{ choice: "apple", name: "identifier", type: "choice" }], usage: billed },
			kind: "body",
		},
	},
	{
		failed: { usage: thousandTokens, why: "judge-refused" },
		name: "a refusal",
		reply: { body: { answers: [{ name: "identifier", type: "refusal" }], usage: billed }, kind: "body" },
	},
	{ failed: { why: "judge-error" }, name: "a status of 500", reply: { kind: "status", status: 500 } },
];

const listed = {
	choice: "apple",
	confidence: 1,
	name: "kind",
	probabilities: [{ probability: 1, value: "apple" }],
	type: "choice",
};

const badKinds: readonly { readonly answer: Schema.Json; readonly name: string }[] = [
	{ answer: Struct.assign(listed, { choice: "pear" }), name: "a choice the question does not list" },
	{ answer: Struct.omit(listed, ["confidence"]), name: "a choice with no confidence" },
	{ answer: Struct.omit(listed, ["probabilities"]), name: "a choice with no probabilities" },
	{
		answer: Struct.assign(listed, { probabilities: [{ probability: 1 }] }),
		name: "a choice probability with no value",
	},
];

it.layer(NodeServices.layer)("the Decisions judge", (test) => {
	test.effect("each question goes to the configured endpoint in its own call", () => eachQuestion);
	test.effect.each(configurations)("$name", configuration);
	test.effect.each(sourceless)("a file that names $name builds no judge", ({ named }) =>
		Effect.map(Effect.flip(configuredJudge(nowhere, named)), (failed) => {
			assert.instanceOf(failed, Schema.SchemaError);
		}),
	);
	test.effect.each(keyless)("$name builds no judge and names the source, not its output", keyUnread);
	test.effect("images ride in one user message after the text", () => withImages);
	test.effect.each(prices)("$inputTokens input tokens cost $cost", priced);
	test.effect.each(failures)("$name fails the call and keeps what it billed", ({ reply, failed }) =>
		Effect.gen(function* failing() {
			const { judge } = yield* mockedJudge(() => reply, fromEnv);
			const failure = yield* Effect.flip(judge.identifier(input, scoreQuestion));

			assert.deepStrictEqual(Struct.pick(failure, ["usage", "why"]), failed);
		}),
	);
	test.effect.each(badKinds)("$name fails the call and keeps what it billed", ({ answer }) =>
		Effect.gen(function* badKind() {
			const reply: Reply = { body: { answers: [answer], usage: billed }, kind: "body" };
			const { judge } = yield* mockedJudge(() => reply, fromEnv);
			const failed = yield* Effect.flip(judge.kind(input, unsortedChoices));

			assert.deepStrictEqual(Struct.pick(failed, ["usage", "why"]), { usage: thousandTokens, why: "judge-error" });
		}),
	);
});
