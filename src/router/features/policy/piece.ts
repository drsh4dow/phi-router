import { Schema } from "effect";

type Base64 = string;

interface Image {
	readonly mimeType: string;
	readonly data: Base64;
}

type PieceKind = "system" | "user" | "tool-result" | "reply-open" | "reply-other";

const Seam = Schema.Struct({ text: Schema.String }).pipe(Schema.brand("Seam"));

interface Piece<Key> {
	readonly key: Key;
	readonly kind: PieceKind;
	readonly texts: readonly string[];
	readonly images: readonly Image[];
	readonly context: readonly string[];
	readonly seam: typeof Seam.Type;
}

export { Seam };

export type { Image, Piece, PieceKind };
