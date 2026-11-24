import { Array, Record as Rec, String as Str, pipe } from "effect";
import type { Field, PhiRecord, RenderInput } from "./record.ts";
import type { Random } from "./random.ts";
import type { TextIdentifier } from "./manifest.ts";
import { compactJson } from "./encodings.ts";
import { healthLabels } from "./labels.ts";
import { identifierKind } from "#router/features/policy/index.ts";
import { systemTime } from "./record.ts";

const segment = (name: string, fields: Readonly<Record<number, string>>): string => {
	const firstPosition = 1;

	const positions = pipe(Rec.keys(fields), Array.map(Number));

	const fieldsUpToLast = Array.makeBy(Math.max(...positions), (index) => fields[index + firstPosition] ?? "");

	return Array.join([name, ...fieldsUpToLast], "|");
};

const states: Array.NonEmptyReadonlyArray<string> = ["OR", "WA", "TX", "FL", "AZ", "NM", "CA"];

type PidPlace = (value: string, state: string) => Readonly<Record<number, string>>;

const pidFields: Readonly<Record<TextIdentifier, PidPlace>> = {
	[identifierKind.birthDate]: (value) => ({ 7: value }),
	[identifierKind.driverLicense]: (value, state) => ({ 20: `${value}^${state}` }),
	[identifierKind.medicalRecordNumber]: (value) => ({ 3: `${value}^^^NFH^MR` }),
	[identifierKind.medicareMedicaidNumber]: (value) => ({ 3: `${value}^^^CMS^MC` }),
	[identifierKind.memberNumber]: () => ({}),
	[identifierKind.passportNumber]: (value) => ({ 3: `${value}^^^USA^PPN` }),
	[identifierKind.patientName]: (value) => ({ 5: value }),
	[identifierKind.personalEmail]: (value) => ({ 13: `^NET^Internet^${value}` }),
	[identifierKind.personalPhone]: (value) => ({ 13: `${value}^PRN^PH` }),
	[identifierKind.socialSecurityNumber]: (value) => ({ 19: value }),
	[identifierKind.streetAddress]: (value, state) => ({ 11: `${value}^^^${state}` }),
};

const insurance = (fields: readonly Field[]): string[] =>
	pipe(
		fields,
		Array.flatMap(({ kind, value }) => {
			if (kind !== identifierKind.memberNumber) {
				return [];
			}

			return [segment("IN1", { 1: "1", 2: "CMHP01", 3: "60054", 36: value, 4: "CASCADE MUTUAL HEALTH PLAN" })];
		}),
	);

/** The MSH and EVN segments of a message, and the control id MSH carries. */
interface MessageHead {
	readonly controlId: string;
	readonly segments: readonly string[];
}

const header = (rng: Random, type: string): MessageHead => {
	const minuteStampLength = 12;
	const controlIdDigits = 8;
	const triggerEventStart = 4;
	const triggerEventEnd = 7;
	const stamp = Str.takeLeft(Str.replaceAll(/\D/gu, "")(systemTime(rng)), minuteStampLength);
	const controlId = `MSG${rng.digits(controlIdDigits)}`;

	const msh = segment("MSH", {
		1: String.raw`^~\&`,
		10: "P",
		11: "2.5.1",
		2: rng.pick(["EPICADT", "CERNER", "MEDITECH"]),
		3: "NFH",
		4: "INTEGRATION",
		5: "ETL",
		6: stamp,
		8: type,
		9: controlId,
	});

	return {
		controlId,
		segments: [msh, segment("EVN", { 1: Str.slice(triggerEventStart, triggerEventEnd)(type), 2: stamp })],
	};
};

const pidSegment = ({ fields, rowId }: PhiRecord, rng: Random): string => {
	const state = rng.pick(states);

	const placed = pipe(
		fields,
		Array.flatMap(({ kind, value }) => Rec.toEntries(pidFields[kind](value, state))),
	);

	return segment(
		"PID",
		Rec.fromEntries([["1", "1"], ["3", `${String(rowId)}^^^NFH^PI`], ["8", rng.pick(["F", "M"])], ...placed]),
	);
};

const hl7v2 = ({ record, rng, minified }: RenderInput): string => {
	const { lang, diagnosis } = record;
	const type = rng.pick(["ADT^A01^ADT_A01", "ADT^A04^ADT_A01", "ADT^A08^ADT_A01"]);
	const { controlId, segments: head } = header(rng, type);

	const segments = [
		...head,
		pidSegment(record, rng),
		segment("PV1", {
			1: "1",
			2: rng.pick(["O", "I", "E"]),
			3: `${rng.pick(["CARD", "ENDO", "ONC", "PSY", "NEPH"])}^^^NFH`,
		}),
		...insurance(record.fields),
		segment("NTE", { 1: "1", 3: `${healthLabels.medication[lang]}: ${diagnosis.medication[lang]}` }),
		segment("DG1", { 1: "1", 3: `${diagnosis.code}^${diagnosis.text[lang]}^I10`, 6: "A" }),
	];

	if (minified) {
		return compactJson({ channel: "ADT_INBOUND", messageControlId: controlId, raw: Array.join(segments, "\r") });
	}

	return Array.join(segments, "\n");
};

export { hl7v2 };
