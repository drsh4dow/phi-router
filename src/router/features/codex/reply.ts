import { Array, Effect, Option, Schema, String as Str, pipe } from "effect";
import { blobsIn, cleanLaneKey } from "./clean-lane.ts";
import type { ContentKey } from "#router/primitives/content-key.ts";
import type { Digest } from "effect/crypto";
import { Item } from "./wire.ts";
import { isReplyItem } from "./groups.ts";
import { itemKey } from "./read.ts";

const SummaryText = Schema.Struct({ text: Schema.String });

const OutputItem = Schema.Struct({ summary: Schema.optionalKey(Schema.Array(SummaryText)) });

const doneType = Schema.Literal("response.output_item.done");

const readEvent = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Struct({ item: OutputItem, type: doneType })),
);

const readItem = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ item: Item, type: doneType })));

const readType = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ type: Schema.String })));

const dataPrefix = "data: ";

const failed = new Set(["response.failed", "error"]);

const dataOf = (line: string): Option.Option<string> =>
	Option.liftPredicate(line, Str.startsWith(dataPrefix)).pipe(Option.map(Str.slice(dataPrefix.length)));

const completed = (lines: readonly string[]): boolean => {
	const types = pipe(
		lines,
		Array.flatMap((line) => Option.toArray(Option.flatMap(dataOf(line), readType))),
		Array.map(({ type }) => type),
	);

	return (
		Array.contains(types, "response.completed") &&
		!pipe(
			types,
			Array.some((type) => failed.has(type)),
		)
	);
};

const keysOf = (data: string): Effect.Effect<readonly (typeof ContentKey.Type)[], never, Digest.Digest> =>
	Option.match(readEvent(data), {
		onNone: () => Effect.succeed([]),
		onSome: ({ item: { summary = [] } }) =>
			Effect.gen(function* keysOfItem() {
				const item = pipe(
					readItem(data),
					Option.map(({ item: read }) => read),
					Option.filter(isReplyItem),
				);

				const own = yield* Option.match(item, { onNone: () => Effect.succeedNone, onSome: itemKey });

				const texts = pipe(
					summary,
					Array.map(({ text }) => text),
				);

				const values = yield* Effect.forEach([...blobsIn(data), ...texts], cleanLaneKey, { concurrency: 1 });

				return [...Option.toArray(own), ...values];
			}),
	});

const cleanLaneKeys = (reply: string): Effect.Effect<readonly (typeof ContentKey.Type)[], never, Digest.Digest> => {
	const lines = Str.split(reply, "\n");

	if (!completed(lines)) {
		return Effect.succeed([]);
	}

	const data = pipe(
		lines,
		Array.flatMap((line) => Option.toArray(dataOf(line))),
	);

	return Effect.map(Effect.forEach(data, keysOf, { concurrency: 1 }), Array.flatten);
};

const reasoningRejected = (answer: string): boolean => Str.includes('"invalid_encrypted_content"')(answer);

export { cleanLaneKeys, reasoningRejected };
