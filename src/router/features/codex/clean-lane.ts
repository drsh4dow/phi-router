import { Array, Effect, String as Str, pipe } from "effect";
import type { ContentKey } from "#router/primitives/content-key.ts";
import type { Digest } from "effect/crypto";
import { contentKey } from "#router/primitives/content-key.ts";

type IsReplyKey = (key: typeof ContentKey.Type) => boolean;

/**
 * An encrypted blob as OpenAI writes it: a Fernet token, whose version byte and zero high time bytes always encode as
 * `gAAAAA`. The other lane decrypts it (measured), so a blob reaches the clean lane only if a clean-lane reply
 * wrote it.
 */
const blob = /gAAAAA[\w-]+=*/gu;

const blobsIn = (text: string): readonly string[] =>
	pipe(
		Str.matchAll(blob)(text),
		Array.fromIterable,
		Array.map(([found]) => found),
	);

/**
 * The key a clean-lane reply's blob or reasoning summary text is remembered under, so the router stores neither.
 *
 * @param {string} value A blob or a summary text.
 * @returns {Effect.Effect<ContentKey, never, Digest.Digest>} Its key.
 */
const cleanLaneKey = (value: string): Effect.Effect<typeof ContentKey.Type, never, Digest.Digest> =>
	contentKey(["clean-lane", value]);

/**
 * The key a clean-lane reply's item is remembered under: its id and what the engine reads of it, so other content
 * under the same id is not that reply's.
 *
 * @param {object} item The item's id, and the JSON of the content the engine reads of it.
 * @returns {Effect.Effect<ContentKey, never, Digest.Digest>} Its key.
 */
const cleanLaneItemKey = (item: {
	readonly id: string;
	readonly content: string;
}): Effect.Effect<typeof ContentKey.Type, never, Digest.Digest> => contentKey(["clean-lane", item.id, item.content]);

const wroteAll =
	(wrote: IsReplyKey) =>
	(values: readonly string[]): Effect.Effect<boolean, never, Digest.Digest> =>
		Effect.map(Effect.forEach(values, cleanLaneKey, { concurrency: 1 }), Array.every(wrote));

export { blobsIn, cleanLaneItemKey, cleanLaneKey, wroteAll };

export type { IsReplyKey };
