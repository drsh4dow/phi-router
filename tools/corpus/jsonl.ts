import { Array, Effect, Schema, String as Str, pipe } from "effect";

class LineInvalid extends Schema.TaggedError<LineInvalid, { readonly brand: unique symbol }>()("LineInvalid", {
	line: Schema.Int,
	message: Schema.String,
	source: Schema.String,
}) {}

interface JsonLines<Line extends Schema.Codec<unknown, string>> {
	readonly schema: Line;
	readonly source: string;
	readonly text: string;
}

const firstLineNumber = 1;

const decodeJsonLines = <Line extends Schema.Codec<unknown, string>>({
	schema,
	source,
	text,
}: JsonLines<Line>): Effect.Effect<Line["Type"][], LineInvalid> => {
	const numbered = pipe(
		Str.split("\n")(text),
		Array.map((content, index) => ({ content, line: index + firstLineNumber })),
		Array.filter(({ content }) => Str.isNonEmpty(Str.trim(content))),
	);

	return Effect.forEach(
		numbered,
		({ content, line }) =>
			Effect.mapError(Schema.decodeEffect(schema)(content), ({ message: why }) =>
				LineInvalid.make({ line, message: `${source} line ${String(line)}: ${why}`, source }),
			),
		{ concurrency: 1 },
	);
};

export { decodeJsonLines };
