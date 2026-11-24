import { Array, Duration, Effect, Option, Schema, Stream, pipe } from "effect";
import type { Asking, ChoiceQuestion, JudgeInput, ScoreQuestion } from "./index.ts";
import type { ChosenJudge } from "./choice.ts";
import { HttpClientRequest } from "effect/http";
import { JudgeFailed } from "./failed.ts";
import type { NamedAccount } from "#router/client/configuration/index.ts";
import type { Usage } from "./failed.ts";
import { askingOf } from "#router/client/accounts/index.ts";
import { textOf } from "./decisions.ts";

/**
 * Claude Code's identity, the first block of every call's system prompt. A Claude login's token answers only a request
 * that opens with it, and an API key takes it as well, so the one prompt that was calibrated runs on both.
 */
const claudeCode = "You are Claude Code, Anthropic's official CLI for Claude.";

/** What a Messages call names. The account drops the login's flag for an API key, and adds its own credential. */
const messagesHeaders = { "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01" };

const claudeModel = "claude-haiku-5-5";

/** The statuses of an answer the judge reads. */
const okStatus = { below: 300, from: 200 } as const;

/** Room for one tool call's answer. A call cut off here fails as `judge-error`. */
const maxTokens = 256;

/**
 * What a call on `claude-haiku-5-5` costs in US dollars per million tokens. A call whose prompt is over `tierTokens`
 * pays the higher rates on all of its tokens.
 */
const haikuPrice = {
	above: { input: 0.5, output: 2.5 },
	tierTokens: 100_000,
	upTo: { input: 0.1, output: 0.5 },
} as const;

const million = 1_000_000;

const Probability = Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 }));

const ScoreCall = Schema.Struct({
	input: Schema.Struct({ probability: Probability }),
	name: Schema.Literal("identifier"),
	type: Schema.Literal("tool_use"),
});

const KindCall = Schema.Struct({
	input: Schema.Struct({ kind: Schema.String }),
	name: Schema.Literal("kind"),
	type: Schema.Literal("tool_use"),
});

const OtherBlock = Schema.Struct({ type: Schema.String });

const Block = Schema.Union([ScoreCall, KindCall, OtherBlock]);

const Reply = Schema.fromJsonString(
	Schema.Struct({
		content: Schema.Array(Block),
		stop_reason: Schema.String,
		usage: Schema.Struct({ input_tokens: Schema.Finite, output_tokens: Schema.Finite }),
	}),
);

type Replied = typeof Reply.Type;

const jsonOf = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

type ToolInputSchema =
	| {
			readonly type: "object";
			readonly properties: {
				readonly probability: { readonly type: "number"; readonly minimum: number; readonly maximum: number };
			};
			readonly required: readonly ["probability"];
	  }
	| {
			readonly type: "object";
			readonly properties: { readonly kind: { readonly type: "string"; readonly enum: readonly string[] } };
			readonly required: readonly ["kind"];
	  };

interface ToolQuestion {
	readonly name: (typeof ScoreCall.Type | typeof KindCall.Type)["name"];
	readonly system: string;
	readonly input: ToolInputSchema;
}

const scoreAsked = ({ instructions, criteria }: ScoreQuestion): ToolQuestion => ({
	input: {
		properties: { probability: { maximum: 1, minimum: 0, type: "number" } },
		required: ["probability"],
		type: "object",
	},
	name: "identifier",
	system: `${instructions}\n\nTrue means: ${criteria.true}\nFalse means: ${criteria.false}\n\nAnswer with the probability, from 0 to 1, that true holds.`,
});

const kindAsked = <Kind extends string>({ instructions, criteria }: ChoiceQuestion<Kind>): ToolQuestion => {
	const listed = pipe(
		criteria,
		Array.map(([choice, description]) => `${choice}: ${description}`),
		Array.join("\n"),
	);

	const choices = pipe(
		criteria,
		Array.map(([choice]) => choice),
	);

	return {
		input: { properties: { kind: { enum: choices, type: "string" } }, required: ["kind"], type: "object" },
		name: "kind",
		system: `${instructions}\n\nChoices:\n${listed}\n\nAnswer with one choice.`,
	};
};

/**
 * One Messages request: the question as the system prompt after Claude Code's identity, the piece as `textOf` gives it
 * then its images in one user message, and the answer forced through the question's one tool.
 *
 * @param {string} model The model the judge runs.
 * @param {ToolQuestion} asked The question.
 * @param {JudgeInput} input The piece, its context and its images.
 * @returns {Effect.Effect} The request's JSON text.
 */
const requestOf = Effect.fnUntraced(function* requestOf(model: string, asked: ToolQuestion, input: JudgeInput) {
	const text = yield* textOf(input);

	const images = pipe(
		input.images,
		Array.map(({ mimeType, data }) => ({ source: { data, media_type: mimeType, type: "base64" }, type: "image" })),
	);

	return yield* Effect.orDie(
		jsonOf({
			max_tokens: maxTokens,
			messages: [{ content: [{ text, type: "text" }, ...images], role: "user" }],
			model,
			system: [
				{ text: claudeCode, type: "text" },
				{ text: asked.system, type: "text" },
			],
			tool_choice: { name: asked.name, type: "tool" },
			tools: [{ input_schema: asked.input, name: asked.name }],
		}),
	);
});

const costOf = ({ input_tokens, output_tokens }: Replied["usage"]): number => {
	if (input_tokens > haikuPrice.tierTokens) {
		return (input_tokens * haikuPrice.above.input + output_tokens * haikuPrice.above.output) / million;
	}

	return (input_tokens * haikuPrice.upTo.input + output_tokens * haikuPrice.upTo.output) / million;
};

/**
 * Sends one request to the account, its login made fit first, and reads the reply. A failed call, a status outside 2xx
 * whatever its body says, or a reply that does not read, fails as `judge-error` with a warning that names the account
 * and never the key.
 *
 * @param {NamedAccount} named The BAA account.
 * @returns {Function} Sends a request's JSON text.
 */
const senderOn = Effect.fnUntraced(function* senderOn(named: NamedAccount) {
	const account = yield* askingOf(named);

	return (body: string): Effect.Effect<{ readonly reply: Replied; readonly ms: number }, JudgeFailed> =>
		Effect.gen(function* sending() {
			yield* account.ready();

			const answered = yield* account.ask(messagesHeaders, (endpoint) =>
				HttpClientRequest.post(`${endpoint}/v1/messages`).pipe(
					HttpClientRequest.bodyText(body, "application/json"),
				),
			);

			if (answered.status < okStatus.from || answered.status >= okStatus.below) {
				return yield* Effect.fail({ message: `status ${String(answered.status)}` });
			}

			const text = yield* Stream.mkString(Stream.decodeText(answered.body));

			return yield* Effect.mapError(Schema.decodeEffect(Reply)(text), () => ({
				message: `status ${String(answered.status)} and no reply it reads`,
			}));
		}).pipe(
			Effect.scoped,
			Effect.timed,
			Effect.tapError((failure) => Effect.logWarning(`The judge call on ${named.name} failed: ${failure.message}`)),
			Effect.mapBoth({
				onFailure: () => JudgeFailed.make({ why: "judge-error" }),
				onSuccess: ([elapsed, reply]) => ({ ms: Duration.toMillis(elapsed), reply }),
			}),
		);
});

const scoreIn = (blocks: Replied["content"]): Option.Option<number> =>
	pipe(
		blocks,
		Array.findFirst(Schema.is(ScoreCall)),
		Option.map(({ input }) => input.probability),
	);

const kindIn = (blocks: Replied["content"]): Option.Option<string> =>
	pipe(
		blocks,
		Array.findFirst(Schema.is(KindCall)),
		Option.map(({ input }) => input.kind),
	);

interface Asker {
	readonly accountName: string;
	readonly model: string;
	readonly send: Effect.Success<ReturnType<typeof senderOn>>;
}

/**
 * One question asked and its answer read. A refusal fails as `judge-refused`. An answer cut off, or one that is not the
 * asked tool call, fails as `judge-error`. Both carry the usage the call billed.
 *
 * @param {Asker} asker How the judge asks.
 * @returns {Function} Asks one question and reads its answer from the reply's blocks.
 */
const askWith =
	({ accountName, model, send }: Asker) =>
	<Answer>(
		input: JudgeInput,
		asked: ToolQuestion,
		answerIn: (blocks: Replied["content"]) => Option.Option<Answer>,
	): Effect.Effect<{ answer: Answer; usage: typeof Usage.Type }, JudgeFailed> =>
		requestOf(model, asked, input).pipe(
			Effect.flatMap(send),
			Effect.flatMap(({ reply, ms }) => {
				const usage = { calls: 1, cost: costOf(reply.usage), inputTokens: reply.usage.input_tokens, ms };

				if (reply.stop_reason === "refusal") {
					return Effect.fail(JudgeFailed.make({ usage, why: "judge-refused" }));
				}

				const called = Option.liftPredicate(reply.content, () => reply.stop_reason === "tool_use");

				return Option.match(pipe(called, Option.flatMap(answerIn)), {
					onNone: () =>
						Effect.andThen(
							Effect.logWarning(
								`The judge on ${accountName} stopped on ${reply.stop_reason} with no ${asked.name} call`,
							),
							Effect.fail(JudgeFailed.make({ usage, why: "judge-error" })),
						),
					onSome: (answer) => Effect.succeed({ answer, usage }),
				});
			}),
		);

const claude = Effect.fnUntraced(function* claude(judge: Extract<ChosenJudge, { readonly name: "claude" }>) {
	const send = yield* senderOn(judge.account);
	const ask = askWith({ accountName: judge.account.name, model: judge.model, send });

	const identifier: Asking["identifier"] = (input, question) =>
		Effect.map(ask(input, scoreAsked(question), scoreIn), ({ answer, usage }) => ({ score: answer, usage }));

	const kind: Asking["kind"] = (input, question) =>
		Effect.flatMap(ask(input, kindAsked(question), kindIn), ({ answer, usage }) =>
			pipe(
				question.criteria,
				Array.findFirst(([choice]) => choice === answer),
				Option.match({
					onNone: () => Effect.fail(JudgeFailed.make({ usage, why: "judge-error" })),
					onSome: ([choice]) => Effect.succeed({ kind: choice, usage }),
				}),
			),
		);

	return { identifier, kind } satisfies Asking;
});

export { claude, claudeModel };
