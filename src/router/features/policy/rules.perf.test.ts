import { Clock, Effect, Option, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { firstHit } from "./rules.ts";

const mebibyte = 1_048_576;

const secondMillis = 1000;

const filled = (head: string, unit: string): string =>
	pipe(unit, Str.repeat(Math.ceil(mebibyte / unit.length)), (body) => head + body, Str.takeLeft(mebibyte));

const codesPerPatient = 140;

const filler = 1000;

const slowTexts = [
	[
		"Patients with 140 codes and no value",
		filled("", `"resourceType":"Patient" ${Str.repeat(codesPerPatient)('"code":"DL" ')}${Str.repeat(filler)("x")}\n`),
	],
	["a Patient and codes with no value", filled('"resourceType":"Patient" ', '"code":"DL" ')],
	["a Patient and values with no code", filled('"resourceType":"Patient" ', '"value":"x" ')],
] as const;

it.live.each(slowTexts)("the rules finish 1 MiB of %s in under a second", ([, text]) =>
	Effect.gen(function* timed() {
		const start = yield* Clock.currentTimeMillis;
		const hit = firstHit(text);
		const elapsed = (yield* Clock.currentTimeMillis) - start;

		assert.deepStrictEqual(hit, Option.none());
		assert.isBelow(elapsed, secondMillis);
	}),
);
