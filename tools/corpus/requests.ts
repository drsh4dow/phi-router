import { Array, Effect, Number as Num, Option, Order, Predicate, Schema, String as Str, pipe } from "effect";
import type { Case, Part, Transcript, Turn } from "./manifest.ts";
import { MockReplies, Steps, fillerMark, planOf } from "./wire.ts";
import type { MockReply, SentPrompt } from "./wire.ts";
import { Base64 } from "effect/encoding";
import type { Cause } from "effect";

type Bytes = Readonly<Uint8Array<Readonly<ArrayBufferLike>>>;

interface Script {
	readonly files: readonly { readonly bytes: Bytes; readonly path: string }[];
	readonly replyAt: (index: number) => MockReply;
}

interface PiState {
	readonly conversation: Transcript;
	readonly pathsRead: readonly string[];
	readonly repliesUsed: number;
	readonly requestsSent: readonly Transcript[];
}

class UnknownToolCall extends Schema.TaggedError<UnknownToolCall, { readonly brand: unique symbol }>()(
	"UnknownToolCall",
	{ input: Schema.String, tool: Schema.String },
) {}

type Failure = UnknownToolCall | Cause.NoSuchElementError | Schema.SchemaError;

const firstLineNumber = 1;

const text = (value: string): Part => ({ kind: "text", text: value });

const userTurn = (sent: SentPrompt): Turn => {
	if (Predicate.isString(sent)) {
		return { parts: [text(sent)], role: "user" };
	}

	const images = pipe(
		sent.images,
		Array.map(({ data, mimeType }): Part => ({ data, kind: "image", mimeType })),
	);

	return { parts: [text(sent.text), ...images], role: "user" };
};

const readFilesOf = (read: readonly string[]): string => {
	const files = Array.sort(Array.dedupe(read), Order.String);

	if (Array.isReadonlyArrayNonEmpty(files)) {
		return `\n\n<read-files>\n${Array.join(files, "\n")}\n</read-files>`;
	}

	return "";
};

const summaryTurn = (summary: string, read: readonly string[]): Turn => {
	const wrapped = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}${readFilesOf(read)}\n</summary>`;

	return { parts: [text(wrapped)], role: "user" };
};

const isFiller = (turn: Turn): boolean =>
	turn.role === "user" &&
	pipe(
		turn.parts,
		Array.some((part) => part.kind === "text" && Str.includes(fillerMark)(part.text)),
	);

const fileAt = (
	files: Script["files"],
	path: string,
): Effect.Effect<{ readonly bytes: Bytes; readonly content: string }, Cause.NoSuchElementError> =>
	pipe(
		files,
		Array.findFirst((file) => file.path === path),
		Effect.fromOption,
		Effect.map(({ bytes }) => ({ bytes, content: new TextDecoder().decode(bytes) })),
	);

const linesOf = (content: string, first: number, last: number): string => {
	const skipped = first - firstLineNumber;

	return pipe(Str.split("\n")(content), Array.drop(skipped), Array.take(last - skipped), Array.join("\n"));
};

const imageTypes = new Map([
	["png", "image/png"],
	["jpg", "image/jpeg"],
	["gif", "image/gif"],
	["webp", "image/webp"],
]);

const Read = Schema.Struct({
	limit: Schema.optionalKey(Schema.Int),
	offset: Schema.optionalKey(Schema.Int),
	path: Schema.String,
});

const pageOf = (content: string, offset: number, limit: number): string => {
	const last = offset - firstLineNumber + limit;
	const page = linesOf(content, offset, last);
	const lineCount = Str.split("\n")(content).length;

	if (lineCount > last) {
		return `${page}\n\n[${String(lineCount - last)} more lines in file. Use offset=${String(last + firstLineNumber)} to continue.]`;
	}

	return page;
};

const readOf =
	(files: Script["files"]) =>
	(call: typeof Read.Type): Effect.Effect<readonly Part[], Cause.NoSuchElementError> =>
		Effect.map(fileAt(files, call.path), ({ bytes, content }): readonly Part[] => {
			const extension = Option.getOrElse(Array.last(Str.split(".")(call.path)), () => "");
			const mimeType = Option.fromNullishOr(imageTypes.get(extension));

			if (Option.isSome(mimeType)) {
				return [{ data: Base64.encode(bytes), kind: "image", mimeType: mimeType.value }];
			}

			if (Predicate.isNumber(call.offset) && Predicate.isNumber(call.limit)) {
				return [text(pageOf(content, call.offset, call.limit))];
			}

			return [text(content)];
		});

const Bash = Schema.Struct({ command: Schema.String });

const fileRead = /^(?:(?:sleep \d+; )?cat|sed -n '(?<first>\d+),(?<last>\d+)p') (?<path>\S+)$/u;

const bashOf = (files: Script["files"]): ((call: typeof Bash.Type) => Effect.Effect<readonly Part[], Failure>) =>
	Effect.fn("bashOf")(function* bash({ command }) {
		const groups = Option.flatMapNullishOr(Str.match(fileRead)(command), (found) => found.groups);
		const path = Option.flatMapNullishOr(groups, (found) => found["path"]);

		if (Option.isNone(path)) {
			return yield* UnknownToolCall.make({ input: command, tool: "bash" });
		}

		const { content } = yield* fileAt(files, path.value);

		const lineOf = (name: "first" | "last"): Option.Option<string> =>
			Option.flatMapNullishOr(groups, (found) => found[name]);

		return Option.match(Option.all([lineOf("first"), lineOf("last")]), {
			onNone: () => [text(content)],
			onSome: ([first, last]) => [text(`${linesOf(content, Number(first), Number(last))}\n`)],
		});
	});

const outputOf = (files: Script["files"], tool: string, json: string): Effect.Effect<readonly Part[], Failure> => {
	if (tool === "bash") {
		return Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Bash))(json), bashOf(files));
	}

	if (tool === "read") {
		return Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Read))(json), readOf(files));
	}

	return Effect.fail(UnknownToolCall.make({ input: "", tool }));
};

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const pathRead = MockReplies.$match({
	Text: () => Option.none<string>(),
	ToolUse: ({ input, name }) => {
		if (name !== "read") {
			return Option.none<string>();
		}

		return Option.map(Schema.decodeUnknownOption(Read)(input), ({ path }) => path);
	},
});

const replyTo = (script: Script, pi: PiState): readonly [reply: MockReply, repliesUsed: number] => {
	if (Option.exists(Array.last(pi.conversation), isFiller)) {
		return [MockReplies.Text({ text: "ok" }), pi.repliesUsed];
	}

	return [script.replyAt(pi.repliesUsed), Num.increment(pi.repliesUsed)];
};

const answered = Effect.fnUntraced(function* answered(script: Script, pi: PiState) {
	const requestsSent = [...pi.requestsSent, pi.conversation];
	const [reply, repliesUsed] = replyTo(script, pi);

	const answer = yield* MockReplies.$match(reply, {
		Text: ({ text: said }) => Effect.succeed<Transcript>([{ parts: [text(said)], role: "assistant" }]),
		ToolUse: ({ input, name, textBefore }) =>
			Effect.gen(function* toolUse() {
				const id = `toolu_mock_${String(requestsSent.length)}`;
				const json = yield* encodeJson(input);
				const output = yield* outputOf(script.files, name, json);

				const said = pipe(
					Option.toArray(textBefore),
					Array.map((value) => text(value)),
				);

				return [
					{ parts: [...said, text(`${name} ${id} ${json}`)], role: "assistant" },
					{ parts: [text(id), ...output], role: "tool" },
				] satisfies Transcript;
			}),
	});

	const pathsRead = [...pi.pathsRead, ...Option.toArray(pathRead(reply))];
	const next: PiState = { conversation: [...pi.conversation, ...answer], pathsRead, repliesUsed, requestsSent };

	return { next, toolUse: MockReplies.$is("ToolUse")(reply) };
});

const prompted = (script: Script, pi: PiState): Effect.Effect<PiState, Failure> =>
	Effect.flatMap(answered(script, pi), ({ next, toolUse }) => {
		if (toolUse) {
			return prompted(script, next);
		}

		return Effect.succeed(next);
	});

const withConversation = (pi: PiState, conversation: Transcript): PiState => ({
	conversation,
	pathsRead: pi.pathsRead,
	repliesUsed: pi.repliesUsed,
	requestsSent: pi.requestsSent,
});

const withTurn = (pi: PiState, turn: Turn): PiState => withConversation(pi, [...pi.conversation, turn]);

const compacted = (pi: PiState, summary: string): PiState => {
	const kept = pipe(
		pi.conversation,
		Array.findLastIndex((turn) => turn.role === "user"),
		Option.getOrElse(() => pi.conversation.length),
	);

	return withConversation(pi, [summaryTurn(summary, pi.pathsRead), ...Array.drop(pi.conversation, kept)]);
};

const requestsOf = Effect.fn("requestsOf")(function* requestsOf(subject: Case) {
	const plan = planOf(subject);

	const script: Script = {
		files: plan.files,
		replyAt: (index) => Option.getOrElse(Array.get(plan.replies, index), () => MockReplies.Text({ text: "done" })),
	};

	let pi: PiState = { conversation: [], pathsRead: [], repliesUsed: 0, requestsSent: [] };

	for (const step of plan.steps) {
		const before = pi;

		pi = yield* Steps.$match(step, {
			Compact: ({ summary }) => Effect.succeed(compacted(before, summary)),
			Turn: ({ prompt, steer }) => {
				const asked = withTurn(before, userTurn(prompt));

				return Option.match(steer, {
					onNone: () => prompted(script, asked),
					onSome: (sent) =>
						Effect.flatMap(answered(script, asked), ({ next }) =>
							prompted(script, withTurn(next, userTurn(sent))),
						),
				});
			},
		});
	}

	return pi.requestsSent;
});

export { requestsOf };
