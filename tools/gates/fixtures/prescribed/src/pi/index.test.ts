import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { activate } from "./index.ts";

it.effect("pi's entry activates without throwing", () =>
	Effect.sync(() => {
		assert.doesNotThrow(activate);
	}),
);
