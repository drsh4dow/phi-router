import { Effect, Schedule } from "effect";
import { TestClock } from "effect/testing";
import { it } from "@effect/vitest";

it.effect("answers within a second", () => Effect.void.pipe(Effect.timeout("1 second"), TestClock.withLive));

it.effect("answers within two seconds", () => TestClock.withLive(Effect.timeout(Effect.void, "2 seconds")));

it.effect("answers within 100 polls", () =>
	Effect.void.pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 }), TestClock.withLive),
);

it.effect("answers within three seconds", () => Effect.timeout(Effect.void, "3 seconds").pipe(TestClock.withLive));
