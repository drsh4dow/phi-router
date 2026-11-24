import { Array, Effect, String as Str, pipe } from "effect";
import { assert, describe, it } from "@effect/vitest";
import type { TextIdentifier } from "./manifest.ts";
import { drawIdentifier } from "./identifiers.ts";
import { identifierKind } from "#router/features/policy/index.ts";
import { seeded } from "./random.ts";

const seeds = 300;

const mbiLength = 11;

const staffAreaCode = "503";

const areaCodeDigits = 3;

const unissuedSsnAreas = { first: 900, last: 999, single: 666 } as const;

const driverLicenseFormats = [
	/^[A-Z]\d{7}$/u,
	/^WDL[A-Z\d]{9}$/u,
	/^\d{3} \d{3} \d{3}$/u,
	/^[A-Z]\d{3}-\d{3}-\d{2}-\d{3}-\d$/u,
] as const;

const drawn = (kind: TextIdentifier): string[] =>
	Array.makeBy(seeds, (seed) => drawIdentifier(kind)({ carrier: "clinical-note", lang: "en", rng: seeded(seed) }));

const formats = Effect.sync(() => {
	const unformatted = pipe(
		drawn(identifierKind.driverLicense),
		Array.filter(
			(value) =>
				!pipe(
					driverLicenseFormats,
					Array.some((format) => format.test(value)),
				),
		),
	);

	assert.deepStrictEqual(unformatted, []);
});

const mbiLetters = Effect.sync(() => {
	const mbis = pipe(
		drawn(identifierKind.medicareMedicaidNumber),
		Array.filter((value) => value.length === mbiLength),
	);

	assert.isNotEmpty(mbis);
	assert.deepStrictEqual(
		pipe(
			mbis,
			Array.filter((mbi) => /[SLOIBZ]/u.test(mbi)),
		),
		[],
	);
});

const ssnAreas = Effect.sync(() => {
	const areas = pipe(
		drawn(identifierKind.socialSecurityNumber),
		Array.map((ssn) => Number(Str.takeLeft(areaCodeDigits)(ssn))),
	);

	assert.deepStrictEqual(
		pipe(
			areas,
			Array.filter(
				(area) =>
					area !== unissuedSsnAreas.single && (area < unissuedSsnAreas.first || area > unissuedSsnAreas.last),
			),
		),
		[],
	);
	assert.include(areas, unissuedSsnAreas.single);
});

const phoneAreas = Effect.sync(() => {
	const staffLines = pipe(
		drawn(identifierKind.personalPhone),
		Array.filter((phone) => Str.takeLeft(areaCodeDigits)(Str.replaceAll(/\D/gu, "")(phone)) === staffAreaCode),
	);

	assert.deepStrictEqual(staffLines, []);
});

describe("identifiers", () => {
	it.effect(
		"a drawn driver's license keeps its format's literal characters and fills each symbol from its alphabet",
		() => formats,
	);
	it.effect("a drawn MBI holds none of the letters S, L, O, I, B and Z", () => mbiLetters);
	it.effect("a drawn SSN's area is 666 or 900 to 999, areas never issued", () => ssnAreas);
	it.effect("a drawn personal phone never uses 503, the staff contacts' area code", () => phoneAreas);
});
