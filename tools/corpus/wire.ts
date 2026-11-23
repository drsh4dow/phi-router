import { Array, Data, Option, Record, Result, String as Str, pipe } from "effect";
import type { Case, Message } from "./manifest.ts";
import { isSteering, isText, playedOf, walk } from "./wire-turns.ts";
import { stepsOf, summaryOf } from "./wire-steps.ts";
import type { At } from "./wire-turns.ts";
import { Base64 } from "effect/encoding";
import type { Schema } from "effect";
import type { Step } from "./wire-steps.ts";

/** What the mock model answers a request with: text, or a tool call with the text before it. */
type Reply = Data.TaggedEnum<{
	Text: { readonly text: string };
	ToolUse: { readonly before: Option.Option<string>; readonly name: string; readonly input: Schema.JsonObject };
}>;

const Replies = Data.taggedEnum<Reply>();

/** A file the case's pi reads, at `path` under its project folder. */
interface Planted {
	readonly path: string;
	readonly bytes: Uint8Array;
}

interface Plan {
	/** The case's system messages, which pi reads from the project's `AGENTS.md`. */
	readonly agents: Option.Option<string>;
	readonly files: readonly Planted[];
	/** What the mock answers each request with, in order, before it answers `done`. */
	readonly replies: readonly Reply[];
	readonly steps: Step[];
}

/** A tool call the mock asks for. Its input's key order is data, since the request carries it as JSON. */
interface Call {
	readonly input: Schema.JsonObject;
	readonly name: string;
}

/** A line range of a tool text, 1-based and inclusive, of at most `pageBytes`, so pi's 50 KB output limit cuts none. */
interface Page {
	readonly first: number;
	readonly last: number;
	readonly bytes: number;
}

const pageBytes = 40_000;

const newlineBytes = 1;

const oneBased = 1;

const extensions = new Map([
	["image/png", "png"],
	["image/jpeg", "jpg"],
	["image/gif", "gif"],
	["image/webp", "webp"],
]);

const pathOf = ({ message, index }: At): string => {
	if (isText(message)) {
		return `files/${String(index)}.txt`;
	}

	return `files/${String(index)}.${extensions.get(message.image.mimeType) ?? "png"}`;
};

const bytesOf = (message: Message): Uint8Array => {
	if (isText(message)) {
		return new TextEncoder().encode(message.text);
	}

	return Result.getOrElse(Base64.decode(message.image.data), () => new Uint8Array());
};

const pagesOf = (text: string): readonly Page[] => {
	const pages: Page[] = [];

	for (const [index, line] of Str.split("\n")(text).entries()) {
		const bytes = new TextEncoder().encode(line).length + newlineBytes;
		const number = index + oneBased;

		const joined = pipe(
			Array.last(pages),
			Option.filter((page) => page.bytes + bytes <= pageBytes),
		);

		if (Option.isSome(joined)) {
			pages.pop();
			pages.push({ bytes: joined.value.bytes + bytes, first: joined.value.first, last: number });
		} else {
			pages.push({ bytes, first: number, last: number });
		}
	}

	return pages;
};

const pageTextsOf = (text: string): readonly string[] => {
	const lines = Str.split("\n")(text);

	return pipe(
		pagesOf(text),
		Array.map(({ first, last }) => Array.join(Array.drop(Array.take(lines, last), first - oneBased), "\n")),
	);
};

const isCat = (subject: Case): boolean => subject.expect === "phi" && subject.strata.entry === "tool-result";

/**
 * A text over one page is read a page at a time, as an agent pages through a long file or output.
 *
 * @param {Case} subject The case.
 * @param {string} path The file that holds the text.
 * @param {string} text The text.
 * @returns {readonly Call[]} One call per page.
 */
const pagedCalls = (subject: Case, path: string, text: string): readonly Call[] => {
	const pages = pagesOf(text);
	const cat = isCat(subject);
	const onePage = 1;

	if (pages.length === onePage) {
		if (cat) {
			return [{ input: { command: `cat ${path}` }, name: "bash" }];
		}

		return [{ input: { path }, name: "read" }];
	}

	return pipe(
		pages,
		Array.map(({ first, last }) => {
			if (cat) {
				return { input: { command: `sed -n '${String(first)},${String(last)}p' ${path}` }, name: "bash" };
			}

			const input = Record.fromEntries([
				["path", path],
				["offset", first],
				["limit", last - first + oneBased],
			]);

			return { input, name: "read" };
		}),
	);
};

/**
 * A steering case's tool call runs for a few seconds, so the steering message arrives while it runs.
 *
 * @param {Case} subject The case.
 * @param {readonly Message[]} after The turn after the tool call, if any.
 * @returns {boolean} Whether the tool call waits for the steering message.
 */
const awaitsSteering = (subject: Case, after: readonly Message[]): boolean =>
	isSteering(subject) &&
	pipe(
		after,
		Array.some((next) => next.role === "user" && isText(next)),
	);

const toolCalls = (subject: Case, at: At): readonly Call[] => {
	const path = pathOf(at);

	if (!isText(at.message)) {
		return [{ input: { path }, name: "read" }];
	}

	if (awaitsSteering(subject, at.after)) {
		return [{ input: { command: `sleep 3; cat ${path}` }, name: "bash" }];
	}

	return pagedCalls(subject, path, at.message.text);
};

/**
 * Each text the case's pi sends as one message: the summary compaction keeps, each page of a paged tool output, or the
 * text.
 *
 * @param {Case} subject The case.
 * @returns {readonly string[]} The texts.
 */
const sentTextsOf = (subject: Case): readonly string[] =>
	pipe(
		walk(subject.messages),
		Array.flatMap(({ message, after }) => {
			if (!isText(message)) {
				return [];
			}

			if (message.role === "tool" && !awaitsSteering(subject, after)) {
				return pageTextsOf(message.text);
			}

			return [Option.getOrElse(summaryOf(message.text), () => message.text)];
		}),
	);

const textsOf = (messages: readonly Message[]): readonly string[] =>
	pipe(
		messages,
		Array.filter(isText),
		Array.map(({ text }) => text),
	);

/**
 * A tool message is a tool call the mock asks for, with the assistant text before it; other assistant text is a reply.
 *
 * @param {Case} subject The case.
 * @param {At} at The turn.
 * @returns {readonly Reply[]} What the mock answers for it.
 */
const replyOf = (subject: Case, at: At): readonly Reply[] => {
	if (at.message.role === "tool") {
		const firstPage = 0;

		const said = pipe(
			at.before,
			Array.filter((message) => message.role === "assistant"),
			textsOf,
			Array.head,
		);

		return pipe(
			toolCalls(subject, at),
			Array.map(({ input, name }, page) =>
				Replies.ToolUse({
					before: pipe(
						said,
						Option.filter(() => page === firstPage),
					),
					input,
					name,
				}),
			),
		);
	}

	const ends =
		at.message.role === "assistant" &&
		!pipe(
			at.after,
			Array.some((next) => next.role === "tool"),
		);

	if (ends && isText(at.message)) {
		return [Replies.Text({ text: at.message.text })];
	}

	return [];
};

const planOf = (subject: Case): Plan => {
	const { leadingReply, walked } = playedOf(subject);

	const systems = pipe(
		subject.messages,
		Array.filter((message) => message.role === "system"),
		textsOf,
	);

	return {
		agents: Option.liftPredicate(Array.join(systems, "\n\n"), Str.isNonEmpty),
		files: pipe(
			walked,
			Array.filter(({ message }) => message.role === "tool"),
			Array.map((at) => ({ bytes: bytesOf(at.message), path: pathOf(at) })),
		),
		replies: [
			...pipe(
				textsOf(leadingReply),
				Array.map((text) => Replies.Text({ text })),
			),
			...pipe(
				walked,
				Array.flatMap((at) => replyOf(subject, at)),
			),
		],
		steps: stepsOf(subject),
	};
};

/**
 * How the corpus wire scenario plays one manifest case through a real pi, and which strings in a request body show
 * that the case's PHI reached it. Pure, so the plan and the tokens are tested without pi.
 */
export { planOf, Replies, sentTextsOf };

export type { Reply };

export { fillerMark, narrativeCap, Steps } from "./wire-steps.ts";

export type { Sent } from "./wire-steps.ts";
