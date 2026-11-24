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
	readonly texts: readonly string[];
	readonly images: readonly Image[];
	readonly context: readonly string[];
	readonly seam: Seam;
}

export type { Image, Piece, PieceKind, Seam };
