import { Array, Duration, Effect, Option, Record, Schema, pipe } from "effect";
import type { Asking, ChoiceQuestion, JudgeInput, ScoreQuestion } from "./index.ts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { ChosenJudge } from "./choice.ts";
import { JudgeFailed } from "./failed.ts";
import type { Usage } from "./failed.ts";
import { readKey } from "#router/client/accounts/index.ts";

const names = { identifier: "identifier", kind: "kind" } as const;

const defaultDecisionsModel = "gpt-6-luna";

const lunaPrice = { perMillion: 0.1, perMillionAboveTier: 0.2, tierTokens: 272_000 } as const;

const million = 1_000_000;

const Predicate = Schema.Struct({
	instructions: Schema.String,
	name: Schema.String,
	type: Schema.Literal("predicate"),
});

const Listed = Schema.Struct({ description: Schema.String, value: Schema.String });

const Choice = Schema.Struct({
	choices: Schema.Array(Listed),
	instructions: Schema.String,
	name: Schema.String,
	type: Schema.Literal("choice"),
});

const ImagePart = Schema.Struct({ image_url: Schema.String, type: Schema.Literal("input_image") });

const TextPart = Schema.Struct({ text: Schema.String, type: Schema.Literal("input_text") });

const Message = Schema.Struct({
	content: Schema.TupleWithRest(Schema.Tuple([TextPart]), [ImagePart]),
	role: Schema.Literal("user"),
});

const Request = Schema.Struct({
	input: Schema.Union([Schema.String, Schema.Tuple([Message])]),
	model: Schema.String,
	questions: Schema.Tuple([Schema.Union([Predicate, Choice])]),
});

const Probability = Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 }));

const ChoiceProbability = Schema.Struct({ probability: Schema.Finite, value: Schema.String });

const Answer = Schema.Union([
	Schema.Struct({ name: Schema.String, probability: Probability, type: Schema.Literal("predicate") }),
	Schema.Struct({
		choice: Schema.String,
		confidence: Schema.Finite,
		name: Schema.String,
		probabilities: Schema.Array(ChoiceProbability),
		type: Schema.Literal("choice"),
	}),
	Schema.Struct({ name: Schema.String, type: Schema.Literal("refusal") }),
]);

const Answers = Schema.Struct({ answers: Schema.Array(Schema.Unknown) });

const noTokens = 0;

const TokenCount = Schema.Finite.check(Schema.isGreaterThan(noTokens));

const Billed = Schema.Struct({ usage: Schema.Struct({ input_tokens: TokenCount }) });

const jsonOf = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const answerTo = (name: string, { answers }: typeof Answers.Type): Option.Option<typeof Answer.Type> => {
	const isAsked = Schema.is(Schema.Struct({ name: Schema.Literal(name) }));

	return pipe(answers, Array.findLast(isAsked), Option.flatMap(Schema.decodeUnknownOption(Answer)));
};

type Answered = Exclude<typeof Answer.Type, { readonly type: "refusal" }>;

interface Asked {
	readonly answer: Answered;
	readonly usage: typeof Usage.Type;
}

/**
 * What the judge reads as text: the JSON of `piece` then `context`, the order the original judge sent, where
 * `sort-keys` would reorder a literal.
 *
 * @param {JudgeInput} input The piece and its context.
 * @returns {Effect.Effect} The text.
 */
const textOf = ({ piece, context }: JudgeInput): Effect.Effect<string> =>
	Effect.orDie(
		jsonOf(
			Record.fromEntries([
				["piece", piece],
				["context", context],
			]),
		),
	);

const inputOf = (input: JudgeInput): Effect.Effect<(typeof Request.Type)["input"]> => {
	const { images } = input;

	return textOf(input).pipe(
		Effect.map((text) => {
			if (!Array.isReadonlyArrayNonEmpty(images)) {
				return text;
			}

			const pictures = pipe(
				images,
				Array.map(({ mimeType, data }) => ({
					image_url: `data:${mimeType};base64,${data}`,
					type: "input_image" as const,
				})),
			);

			return [{ content: [{ text, type: "input_text" as const }, ...pictures], role: "user" as const }] as const;
		}),
	);
};

const predicateOf = ({ instructions, criteria }: ScoreQuestion): typeof Predicate.Type => ({
	instructions: `${instructions}\n\nTrue means: ${criteria.true}\nFalse means: ${criteria.false}`,
	name: names.identifier,
	type: "predicate",
});

const choiceOf = <Kind extends string>({ instructions, criteria }: ChoiceQuestion<Kind>): typeof Choice.Type => ({
	choices: pipe(
		criteria,
		Array.map(([value, description]) => ({ description, value })),
	),
	instructions,
	name: names.kind,
	type: "choice",
});

const costOf = (inputTokens: number): number => {
	if (inputTokens > lunaPrice.tierTokens) {
		return (inputTokens * lunaPrice.perMillionAboveTier) / million;
	}

	return (inputTokens * lunaPrice.perMillion) / million;
};

const unrefused = (answer: typeof Answer.Type, usage: typeof Usage.Type): Effect.Effect<Asked, JudgeFailed> => {
	if (answer.type === "refusal") {
		return Effect.fail(JudgeFailed.make({ usage, why: "judge-refused" }));
	}

	return Effect.succeed({ answer, usage });
};

const scoreOf = ({ answer, usage }: Asked): Effect.Effect<{ score: number; usage: typeof Usage.Type }, JudgeFailed> => {
	if (answer.type !== "predicate") {
		return Effect.fail(JudgeFailed.make({ usage, why: "judge-error" }));
	}

	return Effect.succeed({ score: answer.probability, usage });
};

const kindOf =
	<Kind extends string>(question: ChoiceQuestion<Kind>) =>
	({ answer, usage }: Asked): Effect.Effect<{ kind: Kind; usage: typeof Usage.Type }, JudgeFailed> =>
		pipe(
			question.criteria,
			Array.findFirst(([choice]) => answer.type === "choice" && choice === answer.choice),
			Option.match({
				onNone: () => Effect.fail(JudgeFailed.make({ usage, why: "judge-error" })),
				onSome: ([kind]) => Effect.succeed({ kind, usage }),
			}),
		);

const decisions = Effect.fnUntraced(function* decisions(judge: Extract<ChosenJudge, { readonly name: "decisions" }>) {
	const key = yield* readKey(judge.key);
	const http = yield* HttpClient.HttpClient;
	const endpoint = HttpClientRequest.post(`${judge.endpoint}/decisions`).pipe(HttpClientRequest.bearerToken(key));

	const ask = (
		input: JudgeInput,
		question: typeof Predicate.Type | typeof Choice.Type,
	): Effect.Effect<Asked, JudgeFailed> =>
		inputOf(input).pipe(
			Effect.flatMap((sent) =>
				HttpClientRequest.schemaBodyJson(Request)(endpoint, {
					input: sent,
					model: judge.model,
					questions: [question],
				}),
			),
			Effect.flatMap(http.execute),
			Effect.flatMap(HttpClientResponse.filterStatusOk),
			Effect.flatMap((response) => response.json),
			Effect.timed,
			Effect.tapError((failure) => Effect.logWarning(`The judge call failed: ${failure.message}`)),
			Effect.mapError(() => JudgeFailed.make({ why: "judge-error" })),
			Effect.flatMap(([elapsed, body]) => {
				const inputTokens = Option.match(Schema.decodeUnknownOption(Billed)(body), {
					onNone: () => noTokens,
					onSome: ({ usage }) => usage.input_tokens,
				});

				const usage = { calls: 1, cost: costOf(inputTokens), inputTokens, ms: Duration.toMillis(elapsed) };

				const answer = Option.flatMap(Schema.decodeUnknownOption(Answers)(body), (read) =>
					answerTo(question.name, read),
				);

				return Option.match(answer, {
					onNone: () => Effect.fail(JudgeFailed.make({ usage, why: "judge-error" })),
					onSome: (found) => unrefused(found, usage),
				});
			}),
		);

	const asking: Asking = {
		identifier: (input, question) => Effect.flatMap(ask(input, predicateOf(question)), scoreOf),
		kind: (input, question) => Effect.flatMap(ask(input, choiceOf(question)), kindOf(question)),
	};

	return asking;
});

export { decisions, defaultDecisionsModel, textOf };
