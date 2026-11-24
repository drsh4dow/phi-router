import { Array, Option, String as Str, pipe } from "effect";
import type { Piece } from "#router/features/policy/index.ts";
import { quoteMinChars } from "#router/features/policy/index.ts";

type Quotable<Key> = Pick<Piece<Key>, "key" | "kind" | "texts">;

const linesOf = (texts: readonly string[]): string[] =>
	pipe(
		texts,
		Array.flatMap(Str.split("\n")),
		Array.map(Str.trim),
		Array.filter((line) => line.length >= quoteMinChars),
	);

/**
 * Either holds a whole line of the other, so a quoted part of a long line counts as well as a quoted line.
 *
 * @param {readonly string[]} reply The reply's texts.
 * @param {readonly string[]} sealed The sealed piece's texts.
 * @returns {boolean} Whether one repeats a line of the other.
 */
const repeats = (reply: readonly string[], sealed: readonly string[]): boolean => {
	const replyText = Array.join(reply, "\n");
	const sealedText = Array.join(sealed, "\n");

	return (
		pipe(
			linesOf(reply),
			Array.some((line) => Str.includes(line)(sealedText)),
		) ||
		pipe(
			linesOf(sealed),
			Array.some((line) => Str.includes(line)(replyText)),
		)
	);
};

/**
 * Each `reply-other` piece that repeats a line of a sealed piece before it, with the first such sealed piece.
 *
 * @param {object} root0 The pieces in order and the test for a sealed key.
 * @param {readonly Quotable[]} root0.pieces The pieces in their order.
 * @param {Function} root0.isSealed Whether a key's verdict is sealed.
 * @returns {ReadonlyMap} Each quoting reply's key with the key of the sealed piece it quotes.
 */
const quotingReplies = <Key extends string>({
	pieces,
	isSealed,
}: {
	readonly pieces: readonly Quotable<Key>[];
	readonly isSealed: (key: Key) => boolean;
}): ReadonlyMap<Key, Key> => {
	const sealed: Pick<Quotable<Key>, "key" | "texts">[] = [];
	const quoting = new Map<Key, Key>();

	for (const { key, kind, texts } of pieces) {
		if (kind === "reply-other") {
			const source = pipe(
				sealed,
				Array.findFirst((each) => repeats(texts, each.texts)),
			);

			if (Option.isSome(source)) {
				quoting.set(key, source.value.key);
			}
		}

		if (isSealed(key)) {
			sealed.push({ key, texts });
		}
	}

	return quoting;
};

export { quotingReplies };
