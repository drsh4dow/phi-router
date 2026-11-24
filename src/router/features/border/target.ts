import type { Message } from "#router/features/parts/index.ts";
import { Schema } from "effect";

interface Sealed {
	readonly lane: "sealed";
	readonly upstreamModel: string;
	readonly pinned: boolean;
}

interface Clean {
	readonly lane: "clean";
	readonly upstreamModel: string;
	readonly messages: readonly Message[];
}

type Target = Clean | Sealed;

class CleanLaneRefused extends Schema.TaggedError<CleanLaneRefused, { readonly brand: unique symbol }>()(
	"CleanLaneRefused",
	{ reason: Schema.String },
) {}

export { CleanLaneRefused };

export type { Clean, Sealed, Target };
