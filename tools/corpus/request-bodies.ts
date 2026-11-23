import { Array, Option, Predicate, Record, Schema, String as Str, pipe } from "effect";

/** `Schema.Json` spelled so a function that takes it shows it only reads it. */
type Json = boolean | number | string | null | readonly Json[] | JsonObject;

interface JsonObject {
	readonly [key: string]: Json;
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const isJsonArray = (json: Json): json is readonly Json[] => Array.isArray(json);

const isJsonObject = (json: Json): json is JsonObject => Predicate.isObjectKeyword(json) && !isJsonArray(json);

const stringsOf = (json: Json): readonly string[] => {
	if (Predicate.isString(json)) {
		return [json];
	}

	if (isJsonArray(json)) {
		return pipe(json, Array.flatMap(stringsOf));
	}

	if (isJsonObject(json)) {
		return pipe(Record.values(json), Array.flatMap(stringsOf));
	}

	return [];
};

/**
 * A body as sent, and each string in it once decoded, so a token with a quote or a line break still matches.
 *
 * @param {string} body A request body.
 * @returns {readonly string[]} The body and its strings.
 */
const textsOf = (body: string): readonly string[] => [
	body,
	...pipe(decodeJson(body), Option.toArray, Array.flatMap(stringsOf)),
];

const foundIn = (input: { readonly bodies: readonly string[]; readonly tokens: readonly string[] }): string[] => {
	const texts = pipe(input.bodies, Array.flatMap(textsOf));

	return pipe(
		input.tokens,
		Array.filter((token) => pipe(texts, Array.some(Str.includes(token)))),
	);
};

const isToolResult = (block: Json): boolean => isJsonObject(block) && block["type"] === "tool_result";

/**
 * Pi sends each tool result as its own message, and the Anthropic body groups consecutive ones in one turn.
 *
 * @param {Json} turn One turn of a body's `messages`.
 * @returns {readonly Json[]} Each tool result of the turn, then the rest of it, or the turn as it is.
 */
const turnMessages = (turn: Json): readonly Json[] => {
	if (!isJsonObject(turn)) {
		return [turn];
	}

	const results = pipe(
		Option.fromUndefinedOr(turn["content"]),
		Option.filter(isJsonArray),
		Option.filter(Array.some(isToolResult)),
	);

	return Option.match(results, {
		onNone: () => [turn],
		onSome: (content) => [
			...pipe(content, Array.filter(isToolResult)),
			pipe(
				content,
				Array.filter((block) => !isToolResult(block)),
			),
		],
	});
};

const turnsOf = (messages: Json): readonly Json[] => {
	if (isJsonArray(messages)) {
		return pipe(messages, Array.flatMap(turnMessages));
	}

	return [messages];
};

const messagesOfJson = (json: Json): (readonly string[])[] => {
	if (isJsonArray(json)) {
		return pipe(json, Array.map(stringsOf));
	}

	if (!isJsonObject(json)) {
		return [stringsOf(json)];
	}

	const messages = Option.match(Option.fromUndefinedOr(json["messages"]), { onNone: () => [], onSome: turnsOf });

	const rest = pipe(
		json,
		Record.filter((_value, key) => key !== "messages"),
	);

	return [...pipe(messages, Array.map(stringsOf)), stringsOf(rest)];
};

/**
 * The strings of each message in a request body: each tool result and each other turn of an Anthropic body, with the
 * rest of the body (system prompt, tools) as one more, or each element of the engine eval's message array. A body that
 * is no JSON is one message.
 *
 * @param {string} body A request body.
 * @returns {(readonly string[])[]} The strings of each message.
 */
const messagesOf = (body: string): (readonly string[])[] =>
	Option.match(decodeJson(body), { onNone: () => [[body]], onSome: messagesOfJson });

export { foundIn, messagesOf };
