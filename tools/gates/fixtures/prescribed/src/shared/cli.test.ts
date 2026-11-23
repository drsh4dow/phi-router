import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { spelling } from "./cli.ts";

it.effect("the program is spelled phi-router", () =>
	Effect.gen(function* spelled() {
		yield* Effect.void;

		assert.strictEqual(spelling.program, "phi-router");
	}),
);
