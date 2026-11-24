type Base64 = string;

interface Image {
	readonly mimeType: string;
	readonly data: Base64;
}

type PieceKind = "system" | "user" | "tool-result" | "reply-open" | "reply-other";

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
