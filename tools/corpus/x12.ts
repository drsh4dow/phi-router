import { Array, Number as Num, Option, String as Str, pipe } from "effect";
import type { Field, PhiRecord, RenderInput } from "./record.ts";
import { systemTime, two, valueOf } from "./record.ts";
import type { Random } from "./random.ts";
import type { TextIdentifier } from "./manifest.ts";
import { ascii } from "./people.ts";
import { identifierKind } from "#router/features/policy/index.ts";
import { identifierLabels } from "./labels.ts";

/** Identifiers an 837P cannot leave out: the subscriber's name and member id, which the subscriber's NM1 carries. */
const x12Requires: readonly TextIdentifier[] = [identifierKind.patientName, identifierKind.memberNumber];

const decimal = 10;
const luhnDoubledEvery = 2;

const npiPrefix = "80840";

const digitSum = (value: number): number => Math.floor(value / decimal) + (value % decimal);

/**
 * A valid NPI: Luhn over the `80840` prefix and the first nine digits.
 *
 * @param {string} nine The NPI's first nine digits.
 * @returns {string} The ten-digit NPI.
 */
const npi = (nine: string): string => {
	const sum = pipe(
		Array.fromIterable(`${npiPrefix}${nine}`),
		Array.map(Number),
		Array.reverse,
		Array.chunksOf(luhnDoubledEvery),
		Array.map(([doubled, ...kept]) => digitSum(doubled * luhnDoubledEvery) + Num.sumAll(kept)),
		Num.sumAll,
	);

	return `${nine}${String((decimal - (sum % decimal)) % decimal)}`;
};

const firstServiceYear = 2022;
const lastServiceYear = 2024;
const firstMonth = 1;
const lastMonth = 12;
const firstDay = 1;
const lastDayInEveryMonth = 28;

const drawServiceDate = (rng: Random): string =>
	`${String(rng.between(firstServiceYear, lastServiceYear))}${two(rng.between(firstMonth, lastMonth))}${two(rng.between(firstDay, lastDayInEveryMonth))}`;

type Place = (value: string, label: string) => string;

/** Segments of the subscriber loop, 2010BA, that carry an identifier. */
const subscriberLoop: Partial<Record<TextIdentifier, Place>> = {
	[identifierKind.birthDate]: (value) => `DMG*D8*${value}*F`,
	[identifierKind.streetAddress]: (value) => `N3*${value}`,
	[identifierKind.socialSecurityNumber]: (value) => `REF*SY*${value}`,
};

/** Segments of the claim loop, 2300, that carry an identifier: a native one, else a claim note. */
const claimLoop: Partial<Record<TextIdentifier, Place>> = {
	[identifierKind.medicalRecordNumber]: (value) => `REF*EA*${value}`,
};

const claimNote: Place = (value, label) => `NTE*ADD*${Str.toUpperCase(ascii(label))} ${value}`;

const subscriberPlace = (kind: TextIdentifier): Option.Option<Place> => Option.fromUndefinedOr(subscriberLoop[kind]);

interface Envelope {
	readonly date: string;
	readonly time: string;
	readonly control: string;
}

const referenceIdDigits = 6;
const submitterIdDigits = 5;
const receiverIdDigits = 4;
const npiDrawnDigits = 8;
const employerIdDrawnDigits = 7;
const lowestCharge = 85;
const highestCharge = 420;

interface LoopSegments {
	readonly subscriber: readonly string[];
	readonly claim: readonly string[];
}

const loopSegmentsOf = (record: PhiRecord): LoopSegments => {
	const label = ({ kind }: Field): string => identifierLabels[kind][record.lang];

	const others = pipe(
		record.fields,
		Array.filter(({ kind }) => !Array.contains(x12Requires, kind)),
	);

	const subscriber = pipe(
		others,
		Array.flatMap((field) =>
			pipe(
				subscriberPlace(field.kind),
				Option.map((place) => place(field.value, label(field))),
				Option.toArray,
			),
		),
	);

	const claim = pipe(
		others,
		Array.filter((field) => Option.isNone(subscriberPlace(field.kind))),
		Array.map((field) => (claimLoop[field.kind] ?? claimNote)(field.value, label(field))),
	);

	return { claim, subscriber };
};

const transactionOf = ({ record, rng }: RenderInput, envelope: Envelope): readonly string[] => {
	const required = (kind: TextIdentifier): string => Option.getOrElse(valueOf(kind)(record), () => "");
	const { subscriber, claim } = loopSegmentsOf(record);
	const charge = `${String(rng.between(lowestCharge, highestCharge))}.00`;

	return [
		"ST*837*0001*005010X222A1",
		`BHT*0019*00*${rng.digits(referenceIdDigits)}*${envelope.date}*${envelope.time}*CH`,
		`NM1*41*2*NORTHFIELD BILLING*****46*S${rng.digits(submitterIdDigits)}`,
		"PER*IC*EDI DESK*EM*edi@northfield-health.example",
		`NM1*40*2*CLEARSTREAM EDI*****46*CSE${rng.digits(receiverIdDigits)}`,
		"HL*1**20*1",
		`NM1*85*2*NORTHFIELD CLINIC*****XX*${npi(`1${rng.digits(npiDrawnDigits)}`)}`,
		"N3*200 RIVERFRONT PLAZA",
		"N4*PORTLAND*OR*972040000",
		`REF*EI*93${rng.digits(employerIdDrawnDigits)}`,
		"HL*2*1*22*0",
		"SBR*P*18*******CI",
		`NM1*IL*1*${required(identifierKind.patientName)}****MI*${required(identifierKind.memberNumber)}`,
		...subscriber,
		"NM1*PR*2*CASCADE MUTUAL HEALTH PLAN*****PI*60054",
		`CLM*PCN${String(record.internalId)}*${charge}***11:B:1*Y*A*Y*Y`,
		...claim,
		`HI*ABK:${Str.replaceAll(".", "")(record.diagnosis.code)}`,
		"LX*1",
		`SV1*HC:${rng.pick(["99213", "99214", "99203", "93000", "80053"])}*${charge}*UN*1***1`,
		`DTP*472*D8*${drawServiceDate(rng)}`,
	];
};

const centuryDigits = 2;
const dateDigits = 8;
const dateTimeDigits = 12;
const controlNumberDigits = 9;
const firstGroupControl = 1;
const lastGroupControl = 9999;

/**
 * An 837 professional claim (005010X222A1) for one subscriber with one service line.
 *
 * @param {RenderInput} input The record, the draw source, and whether to write it on one line.
 * @returns {string} The interchange, one segment per line unless minified.
 */
const x12837 = (input: RenderInput): string => {
	const stamp = Str.replaceAll(/\D/gu, "")(systemTime(input.rng));

	const envelope = {
		control: input.rng.digits(controlNumberDigits),
		date: Str.takeLeft(stamp, dateDigits),
		time: Str.slice(dateDigits, dateTimeDigits)(stamp),
	};

	const transaction = transactionOf(input, envelope);

	const segments = [
		`ISA*00*          *00*          *ZZ*NORTHFIELD     *ZZ*CLEARSTREAM    *${Str.slice(centuryDigits)(envelope.date)}*${envelope.time}*^*00501*${envelope.control}*0*P*:`,
		`GS*HC*NORTHFIELD*CLEARSTREAM*${envelope.date}*${envelope.time}*${String(input.rng.between(firstGroupControl, lastGroupControl))}*X*005010X222A1`,
		...transaction,
		`SE*${String(Num.increment(transaction.length))}*0001`,
		`GE*1*${envelope.control}`,
		`IEA*1*${envelope.control}`,
	];

	const terminated = pipe(
		segments,
		Array.map((segment) => `${segment}~`),
	);

	if (input.minified) {
		return Array.join(terminated, "");
	}

	return Array.join(terminated, "\n");
};

export { x12837, x12Requires };
