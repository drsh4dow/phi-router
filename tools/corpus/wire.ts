import { Array, Data, Option, Predicate, Record, Result, String as Str, pipe } from "effect";
import type { Case, Message } from "./manifest.ts";
import { isSteering, isText, playedOf, walk } from "./wire-turns.ts";
import { stepsOf, summaryOf } from "./wire-steps.ts";
import type { At } from "./wire-turns.ts";
import { Base64 } from "effect/encoding";
import type { Schema } from "effect";
import type { Step } from "./wire-steps.ts";
import { textsOf } from "./default-corpus.ts";

type MockReply = Data.TaggedEnum<{
	Text: { readonly text: string };
	ToolUse: { readonly textBefore: Option.Option<string>; readonly name: string; readonly input: Schema.JsonObject };
}>;

const MockReplies = Data.taggedEnum<MockReply>();

interface PlantedFile {
	readonly path: string;
	readonly bytes: Uint8Array;
}

interface Plan {
	readonly files: readonly PlantedFile[];
	readonly replies: readonly MockReply[];
	readonly steps: Step[];
}

interface Call {
	readonly input: Schema.JsonObject;
	readonly name: string;
}

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

const awaitsSteering = (subject: Case, after: At["after"]): boolean =>
	isSteering(subject) && Predicate.isNotUndefined(after) && after.role === "user" && isText(after);

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

const replyOf = (subject: Case, at: At): readonly MockReply[] => {
	if (at.message.role === "tool") {
		const firstPage = 0;

		const said = pipe(
			Option.fromUndefinedOr(at.before),
			Option.filter((message) => message.role === "assistant"),
			Option.filter(isText),
			Option.map(({ text }) => text),
		);

		return pipe(
			toolCalls(subject, at),
			Array.map(({ input, name }, page) =>
				MockReplies.ToolUse({
					input,
					name,
					textBefore: pipe(
						said,
						Option.filter(() => page === firstPage),
					),
				}),
			),
		);
	}

	const ends = at.message.role === "assistant" && (Predicate.isUndefined(at.after) || at.after.role !== "tool");

	if (ends && isText(at.message)) {
		return [MockReplies.Text({ text: at.message.text })];
	}

	return [];
};

const planOf = (subject: Case): Plan => {
	const { leadingReply, walked } = playedOf(subject);

	return {
		files: pipe(
			walked,
			Array.filter(({ message }) => message.role === "tool"),
			Array.map((at) => ({ bytes: bytesOf(at.message), path: pathOf(at) })),
		),
		replies: [
			...pipe(
				textsOf(leadingReply),
				Array.map((text) => MockReplies.Text({ text })),
			),
			...pipe(
				walked,
				Array.flatMap((at) => replyOf(subject, at)),
			),
		],
		steps: stepsOf(subject),
	};
};

export { planOf, MockReplies, sentTextsOf };

export type { MockReply };

export { fillerMark, narrativeCap, Steps } from "./wire-steps.ts";

export type { SentPrompt } from "./wire-steps.ts";
