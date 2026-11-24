import { Array, Effect, Layer, Logger, Option, Schema, String as Str, Struct, pipe } from "effect";
import type { Asked, Json, Said } from "#router/client/mock-upstreams/index.ts";
import type { ChoiceQuestion, JudgeInput, ScoreQuestion } from "#router/client/judge/index.ts";
import { Findings, Verdicts, verdictsFor } from "#router/features/verdicts/index.ts";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { judgeFrom, mockOn } from "./configured.ts";
import { judgingOn, sealingWhen, serveAnthropic } from "#router/client/mock-upstreams/index.ts";
import { Judge } from "#router/client/judge/index.ts";
import type { Piece } from "#router/features/policy/index.ts";

const scoreQuestion: ScoreQuestion = { criteria: { false: "F", true: "T" }, instructions: "Is it so?", type: "bool" };

const choices: ChoiceQuestion<"zebra" | "apple"> = {
	criteria: [
		["zebra", "Z"],
		["apple", "A"],
	],
	instructions: "Which one?",
	type: "choice",
};

const input: JudgeInput = { context: ["c"], images: [], piece: "p" };

const ok = 200;

const failing: Said = { body: "{}", kind: "status", status: 500 };

/** An Anthropic account mock on its own loopback port that answers by `script`. */
const anthropicOn = Effect.fnUntraced(function* anthropicOn(script: (asked: Asked) => Said) {
	const server = yield* Layer.build(NodeHttpServer.layerTest);

	return yield* Effect.provideContext(serveAnthropic(script), server);
});

const sealingClaude = judgingOn({ holdsPhi: () => true, script: () => failing });

const keyed = (vendor: "anthropic" | "openai", name: string, endpoint: string): Json => ({
	endpoint,
	keyEnv: "PHI_TEST_KEY",
	name,
	scheme: "apiKey",
	vendor,
});

const forwarded: Json = { forwarded: true, name: "forwarded", vendor: "anthropic" };

const openaiFolder: Json = { loginFolder: "/nonexistent", name: "openai-folder", vendor: "openai" };

/**
 * A `config.json` with one open account on each vendor, these BAA accounts, of both vendors, on `sealed`, and `beside`.
 *
 * @param {Json[]} sealed The BAA accounts.
 * @param {object} beside The rest of the file.
 * @returns {Json} The file.
 */
const lanes = (sealed: readonly Json[], beside: Readonly<Record<string, Json>> = {}): Json =>
	Struct.assign(beside, {
		clean: [
			{ forwarded: true, name: "open", vendor: "anthropic" },
			{ forwarded: true, name: "open-openai", vendor: "openai" },
		],
		sealed,
		targetModel: { anthropic: "target", openai: "target" },
	});

/** Two Anthropic account mocks and a Decisions mock, and how many calls each received once the judge asked one. */
const choiceOf = Effect.fnUntraced(function* choiceOf(
	file: (endpoints: { readonly first: string; readonly second: string; readonly decisions: string }) => Json,
	layer: "claudeLayer" | "layer" = "layer",
) {
	const first = yield* anthropicOn(sealingClaude);
	const second = yield* anthropicOn(sealingClaude);
	const decisions = yield* mockOn(sealingWhen(() => true));

	const judge = yield* judgeFrom(
		file({ decisions: decisions.endpoint, first: first.endpoint, second: second.endpoint }),
		layer,
	);

	yield* judge.identifier(input, scoreQuestion);

	const received = yield* Effect.all([first.received, second.received, decisions.received], { concurrency: 1 });

	const [firstCalls, secondCalls, decisionsCalls] = pipe(
		received,
		Array.map((calls) => calls.length),
	);

	return { decisions: decisionsCalls, first: firstCalls, name: judge.name, second: secondCalls };
});

const picks = [
	{
		expected: { decisions: 1, first: 0, name: "decisions" as const, second: 0 },
		file: ({ first, decisions }: Record<"first" | "decisions", string>): Json =>
			lanes([keyed("anthropic", "a", first), keyed("openai", "o", decisions)]),
		name: "an OpenAI API-key account on sealed asks Decisions, though an Anthropic account comes first",
	},
	{
		expected: { decisions: 0, first: 1, name: "claude" as const, second: 0 },
		file: ({ first, second }: Record<"first" | "second", string>): Json =>
			lanes([forwarded, openaiFolder, keyed("anthropic", "a", first), keyed("anthropic", "b", second)]),
		name: "with no OpenAI API key, the first Anthropic account with its own credential asks the Claude judge",
	},
	{
		expected: { decisions: 0, first: 0, name: "claude" as const, second: 1 },
		file: ({ first, second }: Record<"first" | "second", string>): Json =>
			lanes([
				{
					endpoint: first,
					keyEnv: "PHI_TEST_KEY",
					lacks: ["claude-haiku-5-5"],
					name: "a",
					scheme: "apiKey",
					vendor: "anthropic",
				},
				keyed("anthropic", "b", second),
				openaiFolder,
			]),
		name: "an Anthropic account that lacks the Claude judge's model is passed over",
	},
	{
		expected: { decisions: 1, first: 0, name: "decisions" as const, second: 0 },
		file: ({ first, decisions }: Record<"first" | "decisions", string>): Json =>
			lanes([keyed("anthropic", "a", first), openaiFolder], {
				judge: { endpoint: decisions, keyEnv: "PHI_TEST_KEY" },
			}),
		name: "a judge block asks Decisions with its own key",
	},
];

const claudeWhateverNamed = Effect.map(
	choiceOf(
		({ first, second, decisions }) =>
			lanes(
				[
					forwarded,
					keyed("openai", "o", decisions),
					keyed("anthropic", "a", first),
					keyed("anthropic", "b", second),
				],
				{ judge: { endpoint: decisions, keyEnv: "PHI_TEST_KEY" } },
			),
		"claudeLayer",
	),
	(got) => {
		assert.deepStrictEqual(got, { decisions: 0, first: 1, name: "claude", second: 0 });
	},
);

const refused = Effect.gen(function* refused() {
	const failed = yield* Effect.flip(judgeFrom(lanes([forwarded, openaiFolder])));

	assert.deepStrictEqual(
		failed.message,
		"config.json names no judge, and sealed holds no account the judge can run on. Add an OpenAI API-key account, or an Anthropic account with its own key or login folder, to sealed, or add a judge block.",
	);
});

/** The Claude judge on one Anthropic API-key account whose mock answers by `script`. */
const claudeAnswering = Effect.fnUntraced(function* claudeAnswering(script: (asked: Asked) => Said) {
	const mock = yield* anthropicOn(script);
	const judge = yield* judgeFrom(lanes([keyed("anthropic", "baa", mock.endpoint), openaiFolder]));

	return { judge, mock };
});

const replied = (body: string): Said => ({ body, kind: "status", status: ok });

const toolUse = (name: string, answer: string, stop = "tool_use"): Said =>
	replied(
		`{"content":[{"id":"toolu_1","input":${answer},"name":"${name}","type":"tool_use"}],"stop_reason":"${stop}","usage":{"input_tokens":1000,"output_tokens":2}}`,
	);

/** What 1000 input and 2 output tokens cost on the Claude judge's model. */
const billed = { calls: 1, cost: 0.000101, inputTokens: 1000 };

const scoredAt = (inputTokens: number): Said =>
	replied(
		`{"content":[{"id":"toolu_1","input":{"probability":0},"name":"identifier","type":"tool_use"}],"stop_reason":"tool_use","usage":{"input_tokens":${String(inputTokens)},"output_tokens":2}}`,
	);

const prices = [
	{ cost: 0.010001, inputTokens: 100_000 },
	{ cost: 0.0500055, inputTokens: 100_001 },
] as const;

const threeQuarters = 0.75;

const eachQuestion = Effect.gen(function* eachQuestion() {
	const scored = yield* claudeAnswering(() => toolUse("identifier", `{"probability":${String(threeQuarters)}}`));
	const kinded = yield* claudeAnswering(() => toolUse("kind", '{"kind":"apple"}'));
	const score = yield* scored.judge.identifier(input, scoreQuestion);
	const kind = yield* kinded.judge.kind(input, choices);

	assert.deepStrictEqual([Struct.omit(score.usage, ["ms"]), Struct.omit(kind.usage, ["ms"])], [billed, billed]);
	assert.deepStrictEqual([score.score, kind.kind], [threeQuarters, "apple"]);
});

const ownKey = Effect.gen(function* ownKey() {
	const { judge, mock } = yield* claudeAnswering(() => toolUse("identifier", '{"probability":0}'));

	yield* judge.identifier(input, scoreQuestion);

	const received = yield* mock.received;
	const sent = yield* Effect.fromOption(Array.head(received));

	assert.deepStrictEqual([sent.path, sent.headers["x-api-key"]], ["/v1/messages", "env-key"]);
	assert.notProperty(sent.headers, "authorization");
	assert.notProperty(sent.headers, "anthropic-beta");
});

const jsonFrom = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const requested = Effect.gen(function* requested() {
	const { judge, mock } = yield* claudeAnswering(() => toolUse("kind", '{"kind":"apple"}'));

	yield* judge.kind({ context: ["c"], images: [{ data: "aW1n", mimeType: "image/png" }], piece: "p" }, choices);

	const received = yield* mock.received;
	const sent = yield* Effect.fromOption(Array.head(received));
	const body = yield* jsonFrom(sent.body);

	assert.deepStrictEqual(body, {
		max_tokens: 256,
		messages: [
			{
				content: [
					{ text: '{"piece":"p","context":["c"]}', type: "text" },
					{ source: { data: "aW1n", media_type: "image/png", type: "base64" }, type: "image" },
				],
				role: "user",
			},
		],
		model: "claude-haiku-5-5",
		system: [
			{ text: "You are Claude Code, Anthropic's official CLI for Claude.", type: "text" },
			{ text: "Which one?\n\nChoices:\nzebra: Z\napple: A\n\nAnswer with one choice.", type: "text" },
		],
		tool_choice: { name: "kind", type: "tool" },
		tools: [
			{
				input_schema: {
					properties: { kind: { enum: ["zebra", "apple"], type: "string" } },
					required: ["kind"],
					type: "object",
				},
				name: "kind",
			},
		],
	});
});

const unanswered = [
	{ name: "an error status", said: failing, warning: "The judge call on baa failed: status 500" },
	{
		name: "a reply it does not read",
		said: replied("{}"),
		warning: "The judge call on baa failed: status 200 and no reply it reads",
	},
] as const;

const trouble = "the piece in trouble";

const pieceOf = (text: string): Piece<string> => ({
	context: [],
	images: [],
	key: text,
	kind: "user",
	seam: "",
	texts: [text],
});

const clearing = judgingOn({ holdsPhi: () => false, script: () => failing });

const failures = [
	{
		name: "a refusal",
		said: replied('{"content":[],"stop_reason":"refusal","usage":{"input_tokens":1000,"output_tokens":2}}'),
		usage: Option.some(billed),
		why: "judge-refused",
	},
	{
		name: "an answer cut off",
		said: toolUse("identifier", '{"probability":1}', "max_tokens"),
		usage: Option.some(billed),
		why: "judge-error",
	},
	{
		name: "a probability above 1",
		said: toolUse("identifier", '{"probability":95}'),
		usage: Option.some(billed),
		why: "judge-error",
	},
	{
		name: "a kind call to the score question",
		said: toolUse("kind", '{"kind":"apple"}'),
		usage: Option.some(billed),
		why: "judge-error",
	},
	{
		name: "an error status, though its body clears the piece",
		said: Struct.assign(toolUse("identifier", '{"probability":0}'), { status: failing.status }),
		usage: Option.none(),
		why: "judge-error",
	},
] as const;

/**
 * The verdicts of two pieces when the Claude judge's account answers `said` about the one in trouble and clears the
 * other.
 */
const sealedBy = Effect.fnUntraced(function* sealedBy(answer: () => Said) {
	const { judge } = yield* claudeAnswering((asked) => {
		if (Str.includes(trouble)(asked.body)) {
			return answer();
		}

		return clearing(asked);
	});

	const { found } = yield* Effect.provideService(
		verdictsFor([pieceOf(trouble), pieceOf("the fine piece")], () => false),
		Judge,
		judge,
	);

	return found;
});

it.layer(NodeServices.layer)("the Claude judge", (test) => {
	test.effect.each(picks)("$name", ({ expected, file }) =>
		Effect.map(choiceOf(file), (got) => {
			assert.deepStrictEqual(got, expected);
		}),
	);

	test.effect(
		"the Claude judge layer asks the first Anthropic account with its own credential, though the file names Decisions",
		() => claudeWhateverNamed,
	);
	test.effect(
		"with no judge block and no account the judge can run on, the file is refused with the reason",
		() => refused,
	);
	test.effect("reads each question's answer from its forced tool call, with what it billed", () => eachQuestion);
	test.effect("calls the Messages API with the account's own key and no login flag", () => ownKey);
	test.effect(
		"asks as Claude Code, the question as system, the piece then its images, and the answer forced through the question's tool",
		() => requested,
	);
	test.effect.each(prices)("$inputTokens input and 2 output tokens cost $cost", ({ cost, inputTokens }) =>
		Effect.gen(function* priced() {
			const { judge } = yield* claudeAnswering(() => scoredAt(inputTokens));
			const { usage } = yield* judge.identifier(input, scoreQuestion);

			assert.deepStrictEqual(Struct.omit(usage, ["ms"]), { calls: 1, cost, inputTokens });
		}),
	);
	test.effect.each(unanswered)(
		"$name fails as judge-error with a warning that names the account",
		({ said, warning }) =>
			Effect.gen(function* warned() {
				const warnings: unknown[] = [];

				const capture = Logger.make(({ message }) => {
					warnings.push(message);
				});

				const { judge } = yield* claudeAnswering(() => said);

				const failure = yield* Effect.provideService(
					Effect.flip(judge.identifier(input, scoreQuestion)),
					Logger.CurrentLoggers,
					new Set([capture]),
				);

				assert.deepStrictEqual([failure.why, warnings], ["judge-error", [[warning]]]);
			}),
	);

	test.effect.each(failures)("$name seals the piece as $why", ({ said, why }) =>
		Effect.map(
			sealedBy(() => said),
			(found) => {
				assert.deepStrictEqual(found, [
					[trouble, Verdicts.Sealed({ finding: Findings.Failure({ why }) })],
					["the fine piece", Verdicts.Cleared({ by: "judge" })],
				]);
			},
		),
	);

	test.effect.each(failures)("$name fails the call as $why with what it billed", ({ said, usage, why }) =>
		Effect.gen(function* kept() {
			const { judge } = yield* claudeAnswering(() => said);
			const failure = yield* Effect.flip(judge.identifier(input, scoreQuestion));

			assert.deepStrictEqual(
				[failure.why, Option.map(Option.fromUndefinedOr(failure.usage), Struct.omit(["ms"]))],
				[why, usage],
			);
		}),
	);

	test.effect("a kind the question does not list fails the call as judge-error", () =>
		Effect.gen(function* offList() {
			const { judge } = yield* claudeAnswering(() => toolUse("kind", '{"kind":"phone"}'));
			const failure = yield* Effect.flip(judge.kind(input, choices));

			assert.strictEqual(failure.why, "judge-error");
		}),
	);
});
