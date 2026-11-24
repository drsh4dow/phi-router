import type { Message } from "#router/features/parts/index.ts";

/** The full history to a BAA account. A pinned request gets no bridge. */
interface Sealed {
	readonly lane: "sealed";
	readonly model: string;
	readonly pinned: boolean;
}

/** What the border returned for a request's messages, same length and order, to an open account. */
interface Clean {
	readonly lane: "clean";
	readonly model: string;
	readonly messages: readonly Message[];
}

type Target = Clean | Sealed;

export type { Clean, Sealed, Target };
