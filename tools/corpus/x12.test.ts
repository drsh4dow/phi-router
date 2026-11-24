import { Array, Effect, Number as Num, Option, String as Str, pipe } from "effect";
import { assert, describe, it } from "@effect/vitest";
import type { PhiRecord } from "./record.ts";
import { TextIdentifiers } from "./manifest.ts";
import { diagnoses } from "./health.ts";
import { drawRecord } from "./phi-records.ts";
import { identifierKind } from "#router/features/policy/index.ts";
import { seeded } from "./random.ts";
import { valueOf } from "./record.ts";
import { x12837 } from "./x12.ts";

const firstSeed = 1;

const lastSeed = 40;

const seeds = Array.range(firstSeed, lastSeed);

const segmentsOf = (interchange: string): readonly string[] =>
	pipe(Str.split("\n")(interchange), Array.map(Str.replace(/~$/u, "")));

const loopOf = (segments: readonly string[], opener: string, closer: string): readonly string[] =>
	pipe(
		segments,
		Array.dropWhile((segment) => !Str.startsWith(opener)(segment)),
		Array.dropWhile(Str.startsWith(opener)),
		Array.takeWhile((segment) => !Str.startsWith(closer)(segment)),
	);

const subscriberSegments = (record: PhiRecord): readonly string[] =>
	pipe(
		Option.all([valueOf(identifierKind.patientName)(record), valueOf(identifierKind.memberNumber)(record)]),
		Option.map(([name, member]) => [`NM1*IL*1*${name}****MI*${member}`]),
		Option.getOrElse(Array.empty),
	);

const tagged =
	(tag: string) =>
	(segments: readonly string[]): readonly string[] =>
		pipe(
			segments,
			Array.filter((segment) => Str.startsWith(`${tag}*`)(segment)),
		);

const npiCheckPrefix = "80840";

const luhnBase = 10;

const luhnDoubledEvery = 2;

const luhnValid = (digits: string): boolean => {
	const sum = pipe(
		Array.fromIterable(digits),
		Array.map(Number),
		Array.reverse,
		Array.map((digit, place) => {
			if (Number.isInteger(place / luhnDoubledEvery)) {
				return digit;
			}

			const doubled = digit * luhnDoubledEvery;

			return Math.floor(doubled / luhnBase) + (doubled % luhnBase);
		}),
		Num.sumAll,
	);

	return Number.isInteger(sum / luhnBase);
};

const handRecord: PhiRecord = {
	diagnosis: Array.headNonEmpty(diagnoses),
	fields: [
		{ kind: identifierKind.patientName, value: "TOVANEK MARA" },
		{ kind: identifierKind.memberNumber, value: "XQZ123456789" },
		{ kind: identifierKind.birthDate, value: "19800214" },
		{ kind: identifierKind.medicalRecordNumber, value: "MRN0042" },
		{ kind: identifierKind.socialSecurityNumber, value: "123-45-6789" },
		{ kind: identifierKind.personalEmail, value: "mara@example.com" },
		{ kind: identifierKind.streetAddress, value: "12 ELM ST" },
	],
	internalId: 4242,
	lang: "en",
};

const handInterchange = (seed: number, minified: boolean): string =>
	x12837({ minified, record: handRecord, rng: seeded(seed) });

const subscriberCarried = Effect.sync(() => {
	const records = pipe(
		TextIdentifiers.literals,
		Array.map((identifier, seed) =>
			drawRecord({
				rng: seeded(seed),
				strata: { carrier: "x12-837", entry: "user", identifier, transform: "plain" },
				used: new Set(),
			}),
		),
	);

	const carried = pipe(
		records,
		Array.map((record) => x12837({ minified: false, record, rng: seeded(record.internalId) })),
		Array.map((interchange) => tagged("NM1*IL")(segmentsOf(interchange))),
	);

	assert.deepStrictEqual(carried, pipe(records, Array.map(subscriberSegments)));
});

const loops = Effect.sync(() => {
	const segments = segmentsOf(handInterchange(firstSeed, false));

	assert.deepStrictEqual(loopOf(segments, "NM1*IL*", "NM1*PR*"), [
		"DMG*D8*19800214*F",
		"REF*SY*123-45-6789",
		"N3*12 ELM ST",
	]);
	assert.deepStrictEqual(loopOf(segments, "CLM*", "HI*"), [
		"REF*EA*MRN0042",
		"NTE*ADD*PERSONAL EMAIL mara@example.com",
	]);
});

const validNpi = Effect.sync(() => {
	const npis = pipe(
		seeds,
		Array.flatMap((seed) => tagged("NM1*85")(segmentsOf(handInterchange(seed, false)))),
		Array.map((segment) => Str.replace(/^.*\*XX\*/u, "")(segment)),
	);

	const invalid = pipe(
		npis,
		Array.filter((npi) => !/^\d{10}$/u.test(npi) || !luhnValid(`${npiCheckPrefix}${npi}`)),
	);

	assert.lengthOf(npis, seeds.length);
	assert.deepStrictEqual(invalid, []);
});

const oneTransaction = Effect.sync(() => {
	const pretty = handInterchange(firstSeed, false);
	const lines = Str.split("\n")(pretty);
	const segments = segmentsOf(pretty);

	assert.deepStrictEqual(
		pipe(
			lines,
			Array.filter((line) => !/^[^~]+~$/u.test(line)),
		),
		[],
	);
	assert.deepStrictEqual(tagged("ST")(segments), ["ST*837*0001*005010X222A1"]);
	assert.deepStrictEqual(tagged("NM1*IL")(segments), ["NM1*IL*1*TOVANEK MARA****MI*XQZ123456789"]);
	assert.deepStrictEqual(tagged("LX")(segments), ["LX*1"]);
	assert.strictEqual(handInterchange(firstSeed, true), Array.join(lines, ""));
});

describe("x12 837", () => {
	it.effect(
		"every 837 case carries the subscriber's name and member id in its NM1*IL segment, whatever its stratum",
		() => subscriberCarried,
	);
	it.effect(
		"an identifier goes in its native 2010BA or 2300 segment, and one with none in a 2300 claim note",
		() => loops,
	);
	it.effect("the billing provider's NPI passes the Luhn check over the 80840 prefix", () => validNpi);
	it.effect(
		"an 837 is one 005010X222A1 transaction with one subscriber and one service line, a segment per line, or one line minified",
		() => oneTransaction,
	);
});
