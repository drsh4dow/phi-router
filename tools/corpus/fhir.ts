import { Array, Record as Rec, pipe } from "effect";
import type { PhiRecord, RenderInput } from "./record.ts";
import { compactJson, prettyJson } from "./encodings.ts";
import type { JsonObject } from "./encodings.ts";
import type { TextIdentifier } from "./manifest.ts";
import { identifierKind } from "#router/features/policy/index.ts";
import { uuid } from "./record.ts";

const v2Identifier = (code: string, system: string, value: string): JsonObject =>
	Rec.fromEntries([
		[
			"type",
			{
				coding: [
					Rec.fromEntries([
						["system", "http://terminology.hl7.org/CodeSystem/v2-0203"],
						["code", code],
					]),
				],
			},
		],
		["system", system],
		["value", value],
	]);

const telecom = (system: string, value: string): JsonObject => ({
	telecom: [
		Rec.fromEntries([
			["system", system],
			["value", value],
			["use", "home"],
		]),
	],
});

/** Where one identifier goes: fields of the Patient resource, and any resources of its own. */
interface Placement {
	readonly patient: JsonObject;
	readonly resources: readonly JsonObject[];
}

type Place = (value: string, patientRef: string) => Placement;

const inPatient =
	(build: (value: string) => JsonObject): Place =>
	(value) => ({ patient: build(value), resources: [] });

const medicareMedicaidIdentifier = (value: string): JsonObject => {
	if (/^\d[A-Z]/u.test(value)) {
		return v2Identifier("MC", "http://hl7.org/fhir/sid/us-mbi", value);
	}

	return v2Identifier("MA", "urn:oid:2.16.840.1.113883.4.927", value);
};

const placements: Readonly<Record<TextIdentifier, Place>> = {
	[identifierKind.patientName]: inPatient((value) => ({
		name: [
			Rec.fromEntries([
				["use", "official"],
				["text", value],
			]),
		],
	})),
	[identifierKind.birthDate]: inPatient((value) => ({ birthDate: value })),
	[identifierKind.streetAddress]: inPatient((value) => ({
		address: [
			Rec.fromEntries([
				["use", "home"],
				["line", [value]],
				["country", "US"],
			]),
		],
	})),
	[identifierKind.personalPhone]: inPatient((value) => telecom("phone", value)),
	[identifierKind.personalEmail]: inPatient((value) => telecom("email", value)),
	[identifierKind.socialSecurityNumber]: inPatient((value) => ({
		identifier: [{ system: "http://hl7.org/fhir/sid/us-ssn", value }],
	})),
	[identifierKind.medicalRecordNumber]: inPatient((value) => ({
		identifier: [v2Identifier("MR", "urn:oid:2.16.840.1.113883.3.4471.1", value)],
	})),
	[identifierKind.driverLicense]: inPatient((value) => ({
		identifier: [v2Identifier("DL", "urn:oid:2.16.840.1.113883.4.3.41", value)],
	})),
	[identifierKind.passportNumber]: inPatient((value) => ({
		identifier: [v2Identifier("PPN", "http://hl7.org/fhir/sid/passport-USA", value)],
	})),
	[identifierKind.medicareMedicaidNumber]: inPatient((value) => ({
		identifier: [medicareMedicaidIdentifier(value)],
	})),
	[identifierKind.memberNumber]: (value, patientRef) => ({
		patient: {},
		resources: [
			Rec.fromEntries([
				["resourceType", "Coverage"],
				["status", "active"],
				["subscriberId", value],
				["beneficiary", { reference: patientRef }],
				["payor", [{ display: "Cascade Mutual Health Plan" }]],
			]),
		],
	}),
};

const condition = ({ diagnosis, lang }: PhiRecord, patientRef: string): JsonObject =>
	Rec.fromEntries([
		["resourceType", "Condition"],
		[
			"clinicalStatus",
			{
				coding: [
					Rec.fromEntries([
						["system", "http://terminology.hl7.org/CodeSystem/condition-clinical"],
						["code", "active"],
					]),
				],
			},
		],
		[
			"code",
			{
				coding: [
					Rec.fromEntries([
						["system", "http://hl7.org/fhir/sid/icd-10-cm"],
						["code", diagnosis.code],
						["display", diagnosis.text[lang]],
					]),
				],
			},
		],
		["subject", { reference: patientRef }],
	]);

const medicationStatement = ({ diagnosis, lang }: PhiRecord, patientRef: string): JsonObject =>
	Rec.fromEntries([
		["resourceType", "MedicationStatement"],
		["status", "active"],
		["medicationCodeableConcept", { text: diagnosis.medication[lang] }],
		["subject", { reference: patientRef }],
	]);

const fhirJson = ({ record, rng, minified }: RenderInput): string => {
	const patientId = uuid(rng);
	const patientRef = `urn:uuid:${patientId}`;

	const placed = pipe(
		record.fields,
		Array.map(({ kind, value }) => placements[kind](value, patientRef)),
	);

	const patient = Rec.fromEntries([
		["resourceType", "Patient"],
		["id", patientId],
		...pipe(
			placed,
			Array.flatMap((placement) => Rec.toEntries(placement.patient)),
		),
		["gender", rng.pick(["female", "male"])],
	]);

	const others: readonly JsonObject[] = [
		...pipe(
			placed,
			Array.flatMap((placement) => placement.resources),
		),
		condition(record, patientRef),
		medicationStatement(record, patientRef),
	];

	const bundle = Rec.fromEntries([
		["resourceType", "Bundle"],
		["id", uuid(rng)],
		["type", rng.pick(["transaction", "collection"])],
		[
			"entry",
			[
				{ fullUrl: patientRef, resource: patient },
				...pipe(
					others,
					Array.map((resource) => ({ fullUrl: `urn:uuid:${uuid(rng)}`, resource })),
				),
			],
		],
	]);

	if (minified) {
		return compactJson(bundle);
	}

	return prettyJson(bundle);
};

export { fhirJson };
