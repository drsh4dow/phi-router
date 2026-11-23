import { Array, Effect, Number as Num, Option, Order, Predicate, Schema, String as Str, pipe } from "effect";
import type { Case, Part, Transcript, Turn } from "./manifest.ts";
import { Replies, Steps, fillerMark, planOf } from "./wire.ts";
import type { Reply, Sent } from "./wire.ts";
import { Base64 } from "effect/encoding";
import type { Cause } from "effect";

/** Bytes this file only reads. */
type Bytes = Readonly<Uint8Array<Readonly<ArrayBufferLike>>>;

/** What the case's mock serves: the files its pi reads, and the scripted reply at each index, `done` past the last. */
interface Script {
	readonly files: readonly { readonly bytes: Bytes; readonly path: string }[];
	readonly replyAt: (index: number) => Reply;
}

/** The conversation pi holds, the files it read, how many scripted replies it used and the requests it sent. */
interface Pi {
	readonly pathsRead: readonly string[];
	readonly requests: readonly Transcript[];
	readonly turns: Transcript;
	readonly used: number;
}

class UnknownToolCall extends Schema.TaggedError<UnknownToolCall, { readonly brand: unique symbol }>()(
	"UnknownToolCall",
	{ input: Schema.String, tool: Schema.String },
) {}

type Failure = UnknownToolCall | Cause.NoSuchElementError | Schema.SchemaError;

/** `sed` and pi's `read` number a file's lines from 1. */
const firstLineNumber = 1;

const text = (value: string): Part => ({ kind: "text", text: value });

const userTurn = (sent: Sent): Turn => {
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

/**
 * A page of a file as pi's `read` returns it, with pi's note on how to read on when lines are left.
 *
 * @param {string} content The whole file.
 * @param {number} offset The page's first line.
 * @param {number} limit How many lines the page holds at most.
 * @returns {string} The page.
 */
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

/** The two ways a scripted bash call reads a file: whole with `cat`, or a range of lines with `sed`. */
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

const pathRead = Replies.$match({
	Text: () => Option.none<string>(),
	ToolUse: ({ input, name }) => {
		if (name !== "read") {
			return Option.none<string>();
		}

		return Option.map(Schema.decodeUnknownOption(Read)(input), ({ path }) => path);
	},
});

const replyTo = (script: Script, pi: Pi): readonly [reply: Reply, used: number] => {
	if (Option.exists(Array.last(pi.turns), isFiller)) {
		return [Replies.Text({ text: "ok" }), pi.used];
	}

	return [script.replyAt(pi.used), Num.increment(pi.used)];
};

const answered = Effect.fnUntraced(function* answered(script: Script, pi: Pi) {
	const requests = [...pi.requests, pi.turns];
	const [reply, used] = replyTo(script, pi);

	const answer = yield* Replies.$match(reply, {
		Text: ({ text: said }) => Effect.succeed<Transcript>([{ parts: [text(said)], role: "assistant" }]),
		ToolUse: ({ before, input, name }) =>
			Effect.gen(function* toolUse() {
				const id = `toolu_mock_${String(requests.length)}`;
				const json = yield* encodeJson(input);
				const output = yield* outputOf(script.files, name, json);

				const said = pipe(
					Option.toArray(before),
					Array.map((value) => text(value)),
				);

				return [
					{ parts: [...said, text(`${name} ${id} ${json}`)], role: "assistant" },
					{ parts: [text(id), ...output], role: "tool" },
				] satisfies Transcript;
			}),
	});

	const pathsRead = [...pi.pathsRead, ...Option.toArray(pathRead(reply))];
	const next: Pi = { pathsRead, requests, turns: [...pi.turns, ...answer], used };

	return { next, toolUse: Replies.$is("ToolUse")(reply) };
});

const prompted = (script: Script, pi: Pi): Effect.Effect<Pi, Failure> =>
	Effect.flatMap(answered(script, pi), ({ next, toolUse }) => {
		if (toolUse) {
			return prompted(script, next);
		}

		return Effect.succeed(next);
	});

const withTurns = (pi: Pi, turns: Transcript): Pi => ({
	pathsRead: pi.pathsRead,
	requests: pi.requests,
	turns,
	used: pi.used,
});

const withTurn = (pi: Pi, turn: Turn): Pi => withTurns(pi, [...pi.turns, turn]);

const compacted = (pi: Pi, summary: string): Pi => {
	const kept = pipe(
		pi.turns,
		Array.findLastIndex((turn) => turn.role === "user"),
		Option.getOrElse(() => pi.turns.length),
	);

	return withTurns(pi, [summaryTurn(summary, pi.pathsRead), ...Array.drop(pi.turns, kept)]);
};

/**
 * The conversation each request carries, in order, without system turns: the scenario's pi sends its own system
 * prompt. Compaction requests are left out, since they route `direct` to the BAA account. A steering message joins
 * the conversation after the prompt's first reply.
 */
const requestsOf = Effect.fn("requestsOf")(function* requestsOf(subject: Case) {
	const plan = planOf(subject);

	const script: Script = {
		files: plan.files,
		replyAt: (index) => Option.getOrElse(Array.get(plan.replies, index), () => Replies.Text({ text: "done" })),
	};

	let pi: Pi = { pathsRead: [], requests: [], turns: [], used: 0 };

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

	return pi.requests;
});

export { requestsOf };
