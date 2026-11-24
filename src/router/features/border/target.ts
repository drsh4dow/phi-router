import type { Message } from "#router/features/parts/index.ts";

interface Sealed {
	readonly lane: "sealed";
	readonly model: string;
	readonly pinned: boolean;
}

interface Clean {
	readonly lane: "clean";
	readonly model: string;
	readonly messages: readonly Message[];
}

type Target = Clean | Sealed;

export type { Clean, Sealed, Target };
