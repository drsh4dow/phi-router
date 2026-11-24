import { Array, Effect, Option, Record, Schema, String as Str, pipe } from "effect";
import { Raw } from "./wire.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const encodeRaw = Schema.encodeEffect(Schema.fromJsonString(Raw));

const isRaw = Schema.is(Raw);

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
