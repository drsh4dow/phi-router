import { Array, Effect, Schema, pipe } from "effect";
import { Digest } from "effect/crypto";

/** SHA-256 over one part's role and content. A retry, a resend and a repeated file read share a key (`parts.ts`). */
const ContentKey = Schema.String.pipe(Schema.brand("ContentKey"));

const field = (value: string): string => `${String(value.length)}:${value}`;

/** The hex SHA-256 of `fields` as UTF-8, each prefixed with its length, so no two field lists share an encoding. */
const contentKey = Effect.fnUntraced(function* contentKey(fields: readonly string[]) {
	const digest = yield* Digest.Digest;
	const encoded = pipe(fields, Array.map(field), Array.join(""));
	const hex = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(encoded));

	return ContentKey.make(hex);
});

export { ContentKey, contentKey };
