import { Effect, Function } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { everyOf } from "./checks.ts";

const noneReceivedFails = Effect.sync(() => {
	assert.isFalse(everyOf([], Function.constTrue));
	assert.isTrue(everyOf(["sent"], Function.constTrue));
});

describe("the wire checks", () => {
	it.effect(
		"a check that every request passes fails when no mock received one, and holds when one did and passed",
		() => noneReceivedFails,
	);
});
