import { Clock, Effect, Option, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { firstHit } from "./rules.ts";

const mebibyte = 1_048_576;

const quarterMebibyte = 262_144;

const secondMillis = 1000;

const filled = (head: string, unit: string, size = mebibyte): string =>
	pipe(unit, Str.repeat(Math.ceil(size / unit.length)), (body) => head + body, Str.takeLeft(size));

const codesPerPatient = 140;

const filler = 1000;

const slowTexts = [
	[
		"1 MiB of Patients with 140 codes and no value",
		filled("", `"resourceType":"Patient" ${Str.repeat(codesPerPatient)('"code":"DL" ')}${Str.repeat(filler)("x")}\n`),
	],
	["1 MiB of a Patient and codes with no value", filled('"resourceType":"Patient" ', '"code":"DL" ')],
	["1 MiB of a Patient and values with no code", filled('"resourceType":"Patient" ', '"value":"x" ')],
	["1 MiB of Patients with open name arrays", filled("", '"resourceType":"Patient" "name":[ x ')],
	["1 MiB of Patients with open telecom arrays", filled("", '"resourceType":"Patient" "telecom":[ x ')],
	[
		"256 KiB of Patients with open identifier arrays",
		filled("", '"resourceType":"Patient" "identifier":[ x ', quarterMebibyte),
	],
] as const;

it.live.each(slowTexts)("the rules finish %s in under a second", ([, text]) =>
	Effect.gen(function* timed() {
		const start = yield* Clock.currentTimeMillis;
		const hit = firstHit(text);
		const elapsed = (yield* Clock.currentTimeMillis) - start;

		assert.deepStrictEqual(hit, Option.none());
		assert.isBelow(elapsed, secondMillis);
	}),
);
