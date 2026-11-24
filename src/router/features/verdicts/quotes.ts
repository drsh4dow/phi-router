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
