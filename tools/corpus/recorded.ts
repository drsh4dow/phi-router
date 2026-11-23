import {
	Array,
	Effect,
	Number as Num,
	Option,
	Order,
	Predicate,
	Record,
	Ref,
	Schema,
	String as Str,
	pipe,
} from "effect";
import type { ChoiceQuestion, JudgeInput } from "#router/client/judge.ts";
import { defaultJudgeModel, policyVersion } from "#router/features/policy/index.ts";
import { Digest } from "effect/crypto";
import { Judge } from "#router/client/judge.ts";
import { JudgeFailed } from "#router/client/judge-failed.ts";
import type { Usage } from "#router/client/judge-failed.ts";
import { decodeJsonLines } from "./jsonl.ts";

const recordingsPath = `${import.meta.dirname}/recordings.jsonl`;

/** A recording names the policy version and each digest it holds by the digest's first 32 hex digits. */
const digestChars = 32;

/** How many calls a judge has made before its first. */
const noCalls = 0;

const Question = Schema.Literals(["identifier", "kind"]);

const Answer = Schema.Union([
	Schema.Struct({ score: Schema.Finite }),
	Schema.Struct({ kind: Schema.String }),
	Schema.Struct({ refused: Schema.Literal(true) }),
]);

const Recording = Schema.Struct({
	answer: Answer,
	context: Schema.String,
	cost: Schema.Finite,
	images: Schema.Array(Schema.String),
	inputTokens: Schema.Finite,
	piece: Schema.String,
	policy: Schema.String,
	question: Question,
});

type Asked = Omit<typeof Recording.Type, "answer" | "inputTokens" | "cost">;

/** A recorded call's answer, other than a refusal, and what it cost. */
type Replayed = Effect.Effect<
	{ readonly answer: Exclude<typeof Answer.Type, { readonly refused: true }>; readonly usage: typeof Usage.Type },
	JudgeFailed
>;

type Keep = (answer: typeof Answer.Type, usage: typeof Usage.Type) => Effect.Effect<void>;

/** The order a recordings line writes its fields in, which every recordings file keeps. */
const lineFields = [
	"policy",
	"question",
	"piece",
	"context",
	"images",
	"answer",
	"inputTokens",
	"cost",
] as const satisfies readonly (keyof typeof Recording.Type)[];

const RecordingLine = Schema.fromJsonString(Recording);

const encodeLine = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const lengthPrefixed = (fields: readonly string[]): string =>
	pipe(
		fields,
		Array.map((field) => `${String(field.length)}:${field}`),
		Array.join(""),
	);

/** What a recording names a call by: the policy version, the question and digests of what the judge read. */
const askerOf = Effect.gen(function* askerOf() {
	const digest = yield* Digest.Digest;
	const version = yield* policyVersion(defaultJudgeModel);
	const policy = Str.takeLeft(version, digestChars);

	const digestOf = (fields: readonly string[]): Effect.Effect<string> => {
		const bytes = new TextEncoder().encode(lengthPrefixed(fields));

		return pipe(
			digest.digestHex(Digest.sha256, bytes),
			Effect.map((hex) => Str.takeLeft(hex, digestChars)),
		);
	};

	return (question: typeof Question.Type, input: JudgeInput): Effect.Effect<Asked> =>
		Effect.all(
			{
				context: digestOf(input.context),
				images: Effect.forEach(input.images, ({ mimeType, data }) => digestOf([mimeType, data]), {
					concurrency: 1,
				}),
				piece: digestOf([input.piece]),
				policy: Effect.succeed(policy),
				question: Effect.succeed(question),
			},
			{ concurrency: 1 },
		);
});

const keyOf = ({ policy, question, piece, context, images }: Asked): string =>
	Array.join([policy, question, piece, context, ...images], " ");

const usageOf = ({ inputTokens, cost }: typeof Recording.Type): typeof Usage.Type => ({
	calls: 1,
	cost,
	inputTokens,
	ms: 0,
});

const choiceOf = <Choice extends string>(question: ChoiceQuestion<Choice>, answer: string): Option.Option<Choice> =>
	pipe(
		question.criteria,
		Array.findFirst(([choice]) => choice === answer),
		Option.map(([choice]) => choice),
	);

const judgeError = (): Effect.Effect<never, JudgeFailed> => Effect.fail(JudgeFailed.make({ why: "judge-error" }));

const replayingJudge = (recorded: (question: typeof Question.Type, input: JudgeInput) => Replayed): Judge["Service"] =>
	Judge.of({
		identifier: (input) =>
			pipe(
				recorded("identifier", input),
				Effect.flatMap(({ answer, usage }) => {
					if ("score" in answer) {
						return Effect.succeed({ score: answer.score, usage });
					}

					return judgeError();
				}),
			),
		kind: (input, question) =>
			pipe(
				recorded("kind", input),
				Effect.flatMap(({ answer, usage }) => {
					if (!("kind" in answer)) {
						return judgeError();
					}

					return Option.match(choiceOf(question, answer.kind), {
						onNone: judgeError,
						onSome: (choice) => Effect.succeed({ kind: choice, usage }),
					});
				}),
			),
	});

/**
 * A judge that answers only from `contents`, a recordings file. A call it has no answer for, including every call
 * recorded under another policy version, fails as a judge error and counts in `unrecorded`.
 */
const recordedJudge = Effect.fn("recordedJudge")(function* recordedJudge(contents: string) {
	const lines = yield* decodeJsonLines({ schema: RecordingLine, source: "recordings.jsonl", text: contents });

	const answers = new Map(
		pipe(
			lines,
			Array.map((line) => [keyOf(line), line] as const),
		),
	);

	const unrecorded = yield* Ref.make(noCalls);
	const askedOf = yield* askerOf;

	const recorded = Effect.fnUntraced(function* recorded(question: typeof Question.Type, input: JudgeInput) {
		const asked = yield* askedOf(question, input);
		const found = Option.fromNullishOr(answers.get(keyOf(asked)));

		if (Option.isNone(found)) {
			yield* Ref.update(unrecorded, Num.increment);

			return yield* judgeError();
		}

		const usage = usageOf(found.value);
		const { answer } = found.value;

		if ("refused" in answer) {
			return yield* JudgeFailed.make({ usage, why: "judge-refused" });
		}

		return { answer, usage };
	});

	return { judge: replayingJudge(recorded), unrecorded: Ref.get(unrecorded) };
});

const refusalKept = (keep: Keep, why: JudgeFailed["why"], usage: JudgeFailed["usage"]): Effect.Effect<void> => {
	if (why === "judge-refused" && Predicate.isNotUndefined(usage)) {
		return keep({ refused: true }, usage);
	}

	return Effect.void;
};

const lineOf = (recording: typeof Recording.Type): Effect.Effect<string, Schema.SchemaError> => {
	const ordered = pipe(
		lineFields,
		Array.map((field) => [field, recording[field]] as const),
	);

	return encodeLine(Record.fromEntries(ordered));
};

const keepingJudge = (
	live: Judge["Service"],
	keeper: (question: typeof Question.Type, input: JudgeInput) => Keep,
): Judge["Service"] =>
	Judge.of({
		identifier: (input, question) => {
			const keep = keeper("identifier", input);

			return live.identifier(input, question).pipe(
				Effect.tap(({ score, usage }) => keep({ score }, usage)),
				Effect.tapError(({ why, usage }) => refusalKept(keep, why, usage)),
			);
		},
		kind: (input, question) => {
			const keep = keeper("kind", input);

			return live.kind(input, question).pipe(
				Effect.tap(({ kind, usage }) => keep({ kind }, usage)),
				Effect.tapError(({ why, usage }) => refusalKept(keep, why, usage)),
			);
		},
	});

/** `live` with every answer and refusal it gives kept, and `contents`, the kept calls as a recordings file. */
const recording = Effect.fn("recording")(function* recording(live: Judge["Service"]) {
	const kept = new Map<string, typeof Recording.Type>();
	const askedOf = yield* askerOf;

	const keeper =
		(question: typeof Question.Type, input: JudgeInput): Keep =>
		(answer, { cost, inputTokens }) =>
			Effect.map(askedOf(question, input), (asked) => {
				kept.set(keyOf(asked), {
					answer,
					context: asked.context,
					cost,
					images: asked.images,
					inputTokens,
					piece: asked.piece,
					policy: asked.policy,
					question: asked.question,
				});
			});

	const contents = Effect.gen(function* contents() {
		const sorted = Array.sortWith(Array.fromIterable(kept), ([key]) => key, Order.String);
		const lines = yield* Effect.forEach(sorted, ([, line]) => lineOf(line), { concurrency: 1 });

		return pipe(
			lines,
			Array.map((line) => `${line}\n`),
			Array.join(""),
		);
	});

	return { contents, judge: keepingJudge(live, keeper) };
});

export { recordedJudge, recording, recordingsPath };
