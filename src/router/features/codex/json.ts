import { Array, Effect, Option, Record, Schema, String as Str, pipe } from "effect";
import { Raw } from "./wire.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const encodeRaw = Schema.encodeEffect(Schema.fromJsonString(Raw));

const isRaw = Schema.is(Raw);

/**
 * Each JSON value with every object's keys sorted, at any depth.
 *
 * @param {readonly unknown[]} values Decoded JSON values.
 * @returns {readonly unknown[]} The same values, keys sorted.
 */
const sortedKeys = (values: readonly unknown[]): readonly unknown[] =>
	pipe(
		values,
		Array.map((value) => {
			if (Array.isArray(value)) {
				return sortedKeys(value);
			}

			if (!isRaw(value)) {
				return value;
			}

			const entries = pipe(
				Record.toEntries(value),
				Array.sortWith(([key]) => key, Str.Order),
			);

			const keys = pipe(
				entries,
				Array.map(([key]) => key),
			);

			const inner = pipe(
				entries,
				Array.map(([, entry]) => entry),
				sortedKeys,
			);

			return Record.fromEntries(Array.zip(keys, inner));
		}),
	);

const stringOrSpace = /(?<string>"(?:[^"\\]|\\.)*")|\s+/gu;

const unspaced = Str.replaceAll(stringOrSpace, "$<string>");

/**
 * `text` with its keys sorted and its spacing dropped when it is JSON that reads back as written, else as it is, so a
 * content key reads one form of the same arguments. JSON with a key twice, or written with escapes, keeps its own
 * form, since a parser keeps only the last of two equal keys and the key must read all the text sent.
 *
 * @param {string} text Text that may be JSON, such as a call's arguments.
 * @returns {Effect.Effect<string>} The text in that one form.
 */
const canonicalText = Effect.fnUntraced(function* canonicalText(text: string) {
	const json = decodeJson(text);

	if (Option.isNone(json)) {
		return text;
	}

	const asRead = yield* encodeJson(json.value);

	if (asRead !== unspaced(text)) {
		return text;
	}

	const [sorted] = sortedKeys([json.value]);

	return yield* encodeJson(sorted);
}, Effect.orDie);

const rawText = (raw: typeof Raw.Type): Effect.Effect<string> => Effect.orDie(encodeRaw(raw));

export { canonicalText, rawText };
