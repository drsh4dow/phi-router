import { Effect } from "effect";

export const outside = [Effect.runPromise(Effect.void), globalThis];
