import { Array, Effect, Option, String as Str, pipe } from "effect";
import type { AssistantMessage, Message, ToolResultMessage } from "#router/features/parts/index.ts";
import type { Case, Part, Transcript } from "./manifest.ts";
import { requestsOf } from "./requests.ts";
import { transcriptOf } from "./manifest.ts";

type Block = ToolResultMessage["content"][number];

type ToolCall = Extract<AssistantMessage["content"][number], { readonly type: "toolCall" }>;

const callPattern = /^(?<name>\S+) (?<id>toolu_mock_\d+) (?<input>\{[\s\S]*\})$/u;

const callOf = (text: string): Option.Option<ToolCall> =>
	pipe(
		Str.match(callPattern)(text),
		Option.flatMapNullishOr((found) => found.groups),
		Option.flatMap(({ id, input, name }) =>
			Option.all([Option.fromNullishOr(name), Option.fromNullishOr(id), Option.fromNullishOr(input)]),
		),
		Option.map(([name, id, json]) => ({ arguments: json, id, name, type: "toolCall" })),
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

const toolResultOf = (parts: readonly Part[]): ToolResultMessage => {
	const [callId, ...output] = parts;

	return {
		content: pipe(
			output,
			Array.map((part) => blockOf(part)),
		),
		isError: false,
		role: "toolResult",
		toolCallId: textOf(Option.toArray(Option.fromUndefinedOr(callId))),
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
