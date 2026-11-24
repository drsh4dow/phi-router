interface Image {
	readonly mimeType: string;
	/** Base64. */
	readonly data: string;
}

type PieceKind = "system" | "user" | "tool-result" | "reply-open" | "reply-other";

/**
 * The end of the previous message of the same role, read in front of a message that goes on from it mid-word. Unbranded:
 * a branded field fails `prefer-readonly-parameter-types` on every parameter that holds a piece.
 */
type Seam = string;

interface Piece<Key> {
	readonly key: Key;
	readonly kind: PieceKind;
	/** The text parts as sent, one by one, so a registered fixture matches a whole part. */
	readonly texts: readonly string[];
	readonly images: readonly Image[];
	/** At most `window` preceding rendered items, already cleared, for the judge to read. */
	readonly context: readonly string[];
	/** The cleared end of the previous message of the same role, when this one goes on from it mid-word; else empty. */
	readonly seam: Seam;
}

export type { Image, Piece, PieceKind, Seam };
