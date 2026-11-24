import type { Message } from "#router/features/parts/index.ts";

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

export type { Clean, Sealed, Target };
