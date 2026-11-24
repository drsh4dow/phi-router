import { Array, Option, pipe } from "effect";
import type { Case, Message } from "./manifest.ts";

type TextMessage = Extract<Message, { readonly text: string }>;

interface At {
	readonly message: Message;
	readonly index: number;
	readonly before: Message | undefined;
	readonly after: Message | undefined;
}

interface Played {
	readonly leadingReply: readonly TextMessage[];
	readonly walked: readonly At[];
}

const neighbor = 1;

const isText = (message: Message): message is TextMessage => "text" in message;

const walk = (turns: readonly Message[]): readonly At[] =>
	pipe(
		turns,
		Array.map((message, index) => ({
			after: Option.getOrUndefined(Array.get(turns, index + neighbor)),
			before: Option.getOrUndefined(Array.get(turns, index - neighbor)),
			index,
			message,
		})),
	);

const playedOf = (subject: Case): Played => {
	const turns = pipe(
		subject.messages,
		Array.filter((message) => message.role !== "system"),
	);

	const leadingReply = pipe(
		Array.head(turns),
		Option.filter((message) => message.role === "assistant"),
		Option.filter(isText),
		Option.toArray,
	);

	return { leadingReply, walked: walk(Array.drop(turns, leadingReply.length)) };
};

const isSteering = (subject: Case): boolean => subject.expect === "phi" && subject.strata.entry === "steering";

export { isSteering, isText, playedOf, walk };

export type { At, Played };
