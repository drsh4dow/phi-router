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

/** The number an editor gives the first line. */
const firstLine = 1;

/**
 * Decodes every non-blank line, failing on the first bad one with its 1-based line number.
 *
 * @param {JsonLines} lines The schema of one line, the source's name for errors, and the text.
 * @returns {Effect.Effect} The decoded lines, in order.
 */
const decodeJsonLines = <Line extends Schema.Codec<unknown, string>>({
	schema,
	source,
	text,
}: JsonLines<Line>): Effect.Effect<Line["Type"][], LineInvalid> => {
	const numbered = pipe(
		Str.split("\n")(text),
		Array.map((content, index) => ({ content, line: index + firstLine })),
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
