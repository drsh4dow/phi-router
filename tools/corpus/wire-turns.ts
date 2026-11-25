import { Array, Option, pipe } from "effect";
import type { Case, Message } from "./manifest.ts";

type TextMessage = Extract<Message, { readonly text: string }>;

interface At {
	readonly message: Message;
	readonly index: number;
	readonly before: Message | undefined;
	readonly after: Message | undefined;
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

const walkedOf = (subject: Case): readonly At[] =>
	walk(
		pipe(
			subject.messages,
			Array.filter((message) => message.role !== "system"),
		),
	);

const isSteering = (subject: Case): boolean => subject.expect === "phi" && subject.strata.entry === "steering";

export { isSteering, isText, walk, walkedOf };

export type { At };
