import { Array, Effect, Schema, pipe } from "effect";
import { Digest } from "effect/crypto";

const ContentKey = Schema.String.pipe(Schema.brand("ContentKey"));

const field = (value: string): string => `${String(value.length)}:${value}`;

const contentKey = Effect.fnUntraced(function* contentKey(fields: readonly string[]) {
	const digest = yield* Digest.Digest;
	const encoded = pipe(fields, Array.map(field), Array.join(""));
	const hex = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(encoded));

	return ContentKey.make(hex);
});

export { ContentKey, contentKey };
