import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { it } from "@effect/vitest";

it.effect("answers within a second", () => Effect.void.pipe(Effect.timeout("1 second"), TestClock.withLive));

it.effect("answers within two seconds", () => TestClock.withLive(Effect.timeout(Effect.void, "2 seconds")));
