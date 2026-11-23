import { Effect, FileSystem } from "effect";

const { argv } = process;

export const started = Effect.runFork(Effect.void);
export const outside = [argv, FileSystem.FileSystem];
