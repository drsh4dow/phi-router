import { Array, Effect, Option, Schema, String as Str, pipe } from "effect";
import type { AssistantMessage, Message, ToolResultMessage } from "#router/features/parts/index.ts";
import type { Case, Part, Transcript } from "./manifest.ts";
import { requestsOf } from "./requests.ts";
import { transcriptOf } from "./manifest.ts";

type Block = ToolResultMessage["content"][number];

type ToolCall = Extract<AssistantMessage["content"][number], { readonly type: "toolCall" }>;

/** `requests.ts` writes a tool call as `<name> <id> <json input>`. */
const callPattern = /^(?<name>\S+) (?<id>toolu_mock_\d+) (?<input>\{[\s\S]*\})$/u;

const Input = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

const decodeInput = Schema.decodeUnknownOption(Input);

const encodeInput = Schema.encodeUnknownOption(Input);

const callFrom = (groups: Readonly<Record<string, string>>): Option.Option<ToolCall> => {
	const input = pipe(
		decodeInput(groups["input"]),
		Option.flatMap((decoded) => encodeInput(decoded)),
	);

	const fields = Option.all([Option.fromNullishOr(groups["name"]), Option.fromNullishOr(groups["id"]), input]);

	return pipe(
		fields,
		Option.map(([name, id, json]) => ({ arguments: json, id, name, type: "toolCall" })),
	);
};

/**
 * The call's input as a harness encodes it again after decoding it.
 *
 * @param {string} text A reply part's text.
 * @returns {Option.Option<ToolCall>} The tool call the text writes, or none when it writes none.
 */
const callOf = (text: string): Option.Option<ToolCall> =>
	pipe(
		Str.match(callPattern)(text),
		Option.flatMapNullishOr((found) => found.groups),
		Option.flatMap((groups) => callFrom(groups)),
	);

const blockOf = (part: Part): Block => {
	if (part.kind === "text") {
		return { text: part.text, type: "text" };
	}

	return { data: part.data, mimeType: part.mimeType, type: "image" };
};

const textOf = (parts: readonly Part[]): string =>
	pipe(
		parts,
		Array.flatMap((part) => {
			if (part.kind === "text") {
				return [part.text];
			}

			return [];
		}),
		Array.join("\n"),
	);

/**
 * A corpus reply counts as written on a BAA account, so the router judges it.
 *
 * @param {readonly Part[]} parts The reply's parts.
 * @returns {AssistantMessage} The reply as the router reads it.
 */
const replyOf = (parts: readonly Part[]): AssistantMessage => ({
	content: pipe(
		parts,
		Array.map((part) => {
			const text = textOf([part]);

			return Option.getOrElse(callOf(text), () => ({ text, type: "text" }) as const);
		}),
	),
	role: "assistant",
	writtenBy: "other",
});

/**
 * A tool turn's first part is its call's id.
 *
 * @param {readonly Part[]} parts The tool turn's parts.
 * @returns {ToolResultMessage} The tool result as the router reads it.
 */
const toolResultOf = (parts: readonly Part[]): ToolResultMessage => {
	const [, ...output] = parts;

	return {
		content: pipe(
			output,
			Array.map((part) => blockOf(part)),
		),
		isError: false,
		role: "toolResult",
		toolCallId: textOf(Option.toArray(Array.head(parts))),
	};
};

const messageOf = ({ role, parts }: Transcript[number]): Message => {
	switch (role) {
		case "system": {
			return { content: textOf(parts), role, sections: [], tools: [] };
		}

		case "user": {
			return {
				content: pipe(
					parts,
					Array.map((part) => blockOf(part)),
				),
				role,
			};
		}

		case "assistant": {
			return replyOf(parts);
		}

		case "tool": {
			return toolResultOf(parts);
		}

		default: {
			const unhandled: never = role;

			return unhandled;
		}
	}
};

const requestMessagesOf = Effect.fn("requestMessagesOf")(function* requestMessagesOf(subject: Case) {
	const system = transcriptOf(
		pipe(
			subject.messages,
			Array.filter(({ role }) => role === "system"),
		),
	);

	const requests = yield* Effect.orDie(requestsOf(subject));

	return pipe(
		requests,
		Array.map((request) =>
			pipe(
				[...system, ...request],
				Array.map((turn) => messageOf(turn)),
			),
		),
	);
});

export { requestMessagesOf };
