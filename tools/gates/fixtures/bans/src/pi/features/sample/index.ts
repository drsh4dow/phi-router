import { Effect } from "effect";

const { env } = process;

export const ran = Effect.runFork(Effect.void);
export const outside = [env, performance.now(), globalThis.queueMicrotask];
