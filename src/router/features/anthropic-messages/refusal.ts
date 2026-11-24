import { Array, Option, Schema, pipe } from "effect";
import { forwarded, isForwarded } from "./wire.ts";
import { itemsOf, textOf } from "./spans.ts";
import type { ForwardedKey } from "./wire.ts";
import type { Span } from "./spans.ts";

const fits = (key: ForwardedKey, text: string): boolean => {
	const decode = Schema.decodeOption(Schema.fromJsonString(forwarded[key]));

	return Option.isSome(decode(text, { onExcessProperty: "error" }));
};

const carriersOf = (body: Span): readonly (readonly [string, Span])[] => {
	const withBlocks = (path: string, object: Span): readonly (readonly [string, Span])[] => [
		[path, object],
		...pipe(
			itemsOf("content")(object),
			Array.flatMap((block, index) => withBlocks(`${path}.content[${String(index)}]`, block)),
		),
	];

	return [
		...pipe(
			itemsOf("system")(body),
			Array.map((block, index) => [`system[${String(index)}]`, block] as const),
		),
		...pipe(
			itemsOf("messages")(body),
			Array.flatMap((message, index) => withBlocks(`messages[${String(index)}]`, message)),
		),
	];
};

const refusalsOf = (body: Span): readonly string[] =>
	pipe(
		carriersOf(body),
		Array.flatMap(([path, object]) =>
			pipe(
				object.members,
				Array.filter((member) => isForwarded(member.key) && !fits(member.key, textOf(member.value))),
				Array.map((member) => `${path}.${member.key}`),
			),
		),
	);

export { refusalsOf };
