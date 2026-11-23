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

/** A finished item read as its echo is, so both give one key. Fields the echo drops, such as `metadata`, are ignored. */
const readItem = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ item: Item, type: doneType })));

const readType = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ type: Schema.String })));

const dataPrefix = "data: ";

/** The events that end a reply that did not complete, though it may still carry finished items. */
const failed = new Set(["response.failed", "error"]);

const dataOf = (line: string): Option.Option<string> =>
	Option.liftPredicate(line, Str.startsWith(dataPrefix)).pipe(Option.map(Str.slice(dataPrefix.length)));

/**
 * Whether a reply ran to `response.completed` with no failure on the way, so its items are ones the account wrote.
 *
 * @param {readonly string[]} lines The reply's lines.
 * @returns {boolean} Whether it completed.
 */
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

/**
 * The keys of one finished output item, read from its `data:` line: the item's own key when it is a reply item, and
 * one for each blob and reasoning summary text in it.
 *
 * @param {string} data The line less its `data: ` prefix.
 * @returns {Effect.Effect<readonly ContentKey[], never, Digest.Digest>} Its keys, or none for any other event.
 */
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

/**
 * The keys of what a streamed reply wrote: each output item, by its id and content, each blob in it and each reasoning
 * summary text, or none when the reply did not reach `response.completed` or failed. The router keeps them for the
 * session's clean-lane replies only, and `decodeRequest` reads them back as `cleanLaneWrote`.
 *
 * @param {string} reply The reply's server-sent events, whole.
 * @returns {Effect.Effect<readonly ContentKey[], never, Digest.Digest>} Its keys.
 */
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

/**
 * Whether an account's error answer says it could not read an encrypted reasoning item, so the same
 * request without reasoning may pass.
 *
 * @param {string} answer The error answer's body.
 * @returns {boolean} Whether it names `invalid_encrypted_content`.
 */
const reasoningRejected = (answer: string): boolean => Str.includes('"invalid_encrypted_content"')(answer);

export { cleanLaneKeys, reasoningRejected };
