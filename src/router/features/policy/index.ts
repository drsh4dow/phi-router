export {
	identifierKind,
	identifierKindNames,
	identifierQuestion,
	judgeLimits,
	kindQuestion,
	quoteMinChars,
	seamChars,
	stubs,
	thresholds,
	window,
} from "./policy.ts";

export type { IdentifierKind } from "./policy.ts";

export type { Image, Piece, PieceKind, Seam } from "./piece.ts";

export { Rules, firstHit, firstHitOf } from "./rules.ts";

export type { RuleId } from "./rules.ts";

export { Synthetic, blankerOf } from "./synthetic.ts";

export { policyVersion } from "./version.ts";
