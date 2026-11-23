import { Effect, FileSystem, Runtime } from "effect";
import { runFork as start } from "effect/Effect";

const host = globalThis;
const { parse } = JSON;
const { warn } = console;
const clock = performance;
const { setTimeout: later } = host;

export const ran = [Effect.runPromise(Effect.void), start(Effect.void), Runtime.makeRunMain];
export const disk = FileSystem.FileSystem;
export const outside = [parse, warn, clock, later, "Bun" in global, Date(), process.argv, crypto.randomUUID(), fetch, setTimeout];
