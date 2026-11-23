import { Effect } from "effect";

export const outside = [Effect.runFork(Effect.void), process.env];
