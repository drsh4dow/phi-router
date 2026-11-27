import { Array, Effect, Option, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import type { RuleId } from "./rules.ts";
import { firstHit } from "./rules.ts";

const msh = String.raw`MSH|^~\&|EPIC|HOSP|||20240105||ADT^A01|1|P|2.5`;

const isa =
	"ISA*00*          *00*          *ZZ*SUBMITTER      *ZZ*PAYER          *240105*1200*^*00501*000000001*0*P*:~";

const header = `${isa}GS*HC*SUBMITTER*PAYER*20240105*1200*1*X*005010X222A1~ST*837*0001*005010X222A1~`;

const v20203 = "http://terminology.hl7.org/CodeSystem/v2-0203";

const codedPatient = (code: string, value: string): string =>
	`{"resourceType": "Patient", "identifier": [{"type": {"coding": [{"system": "${v20203}", "code": "${code}"}]}, "value": "${value}"}], "gender": "male"}`;

const coding = (code: string): string => `{"coding": [{"system": "${v20203}", "code": "${code}"}]}`;

const extension = '[{"url": "https://example.org/verified", "valueBoolean": true}]';

const pastPatientReach = 3100;

const farFromPatient = Str.repeat(pastPatientReach)("A");

const pastCodeReach = 600;

const farFromCode = Str.repeat(pastCodeReach)("A");

const codedFires = pipe(
	["DL", "PPN", "DP", "SS", "MR", "MRT", "MB", "SN", "MA", "MC", "AN", "BCT"],
	Array.map((code) => ["fhir-coded-id", codedPatient(code, "B3053196")] as const),
);

const codedLayouts = pipe(
	[
		`{"identifier": [{"type": ${coding("DL")}, "value": "B3053196"}], "resourceType": "Patient"}`,
		`{"resourceType": "Patient", "identifier": [{"value": "B3053196", "type": ${coding("DL")}}]}`,
		`{"resourceType": "Patient", "identifier": [{"type": ${coding("DL")}, "extension": ${extension}, "value": "B3053196"}]}`,
		`{"resourceType": "Patient", "identifier": [{"type": {"coding": [{"system": "${v20203}", "code": "DL"}], "extension": ${extension}}, "value": "B3053196"}]}`,
		`{"resourceType": "Patient", "identifier": [{"value": "B3053196", "extension": ${extension}, "type": ${coding("DL")}}]}`,
		`{"resourceType": "Patient", "text": {"div": "<div>${farFromPatient}</div>"}, "identifier": [{"type": ${coding("DL")}, "value": "B3053196"}]}`,
	],
	Array.map((text) => ["fhir-coded-id", text] as const),
);

const fires: readonly (readonly [RuleId, string])[] = [
	["ssn", "Patient SSN 078-05-1120 on file"],
	["mbi", "Medicare beneficiary 3WR7-KX2-PN45 was billed twice"],
	["mbi", "mbi=3WR7KX2PN45"],
	["hl7-pid", `${msh}\rPID|1||00482913^^^MRN||FAKESMITH^CANARY||19000101|F`],
	["hl7-pid", `${msh}\rPID|1||00482913^^^MRN||^^||19000101|F`],
	["hl7-pid", String.raw`{"hl7": "${msh}\rPID|1||||FAKESMITH^CANARY"}`],
	["hl7-pid", `${msh}\rPID|1||VSP-2171^^^USA^U|||||M`],
	["hl7-pid", String.raw`{"raw":"MSH|^~\\&|EPIC|HOSP|||20240105||ADT^A01|1|P|2.5\rPID|1||PXD-8776^^^USA^U|||||F"}`],
	["hl7-pid", `${msh}\rPID|1||4471^^^NFH^PI~00482913^^^NFH^MR|||||F`],
	[
		"fhir-patient",
		'{"resourceType": "Patient", "id": "8812", "name": [{"family": "Fakesmith", "given": ["Canary"]}]}',
	],
	["fhir-patient", '{"resourceType": "Patient", "id": "8812", "birthDate": "1900-01-01"}'],
	[
		"fhir-patient",
		'{"resourceType": "Patient", "identifier": [{"system": "http://hl7.org/fhir/sid/us-ssn", "value": "078051120"}]}',
	],
	[
		"fhir-patient",
		'{"resourceType": "Patient", "identifier": [{"value": "XGH492817305", "system": "https://payer.example/member-id"}]}',
	],
	[
		"fhir-patient",
		'{"resourceType":"Patient","identifier":[{"system":"http://example.org/fhir/sid/vehicle","value":"HTS-0980"}]}',
	],
	[
		"fhir-patient",
		'{"resuorceType": "Patient", "telecom": [{"sytsem": "phone", "value": "(503) 555-0142", "use": "home"}]}',
	],
	[
		"fhir-coded-id",
		'{"resourceTpye": "Patient", "identifier": [{"type": {"codding": [{"code": "AN"}]}, "value": "5476093716"}]}',
	],
	[
		"fhir-patient",
		'{"resourceType": "Patient", "identifier": [{"system": "http://example.org/fhir/sid/veicle", "vlue": "N8RMNR39A9C5J2MRS"}]}',
	],
	[
		"fhir-patient",
		'{"resourceType":"Patient","name":[{"use":"official","text":"Canary Fakesmith"}],"gender":"female"}',
	],
	[
		"fhir-patient",
		'{"resourceType": "Patient", "telecom": [{"system": "url", "value": "https://fakesmith.example.net/", "use": "home"}]}',
	],
	...codedFires,
	...codedLayouts,
	[
		"fhir-patient-device",
		'{"resourceType": "Device", "serialNumber": "SN-X4TTA8J9FU", "patient": {"reference": "urn:uuid:db962aa3"}}',
	],
	[
		"fhir-patient-device",
		'{"resourceType":"Device","patient":{"reference":"Patient/8812"},"serialNumber":"(01)00844588003288(21)A10293"}',
	],
	["x12-member", `${header}NM1*IL*1*FAKESMITH*CANARY****MI*XGH492817305~`],
	["x12-member", `${header}NM1*QC*1******MI*XGH492817305~`],
	["file-name-phone", "exports/outbox/7340_5035550147_copd_discharge-summary.pdf"],
	["file-name-phone", "scans/2448_(412) 555-0119_asthma_referral.pdf"],
	["file-name-phone", '{"files": ["outbox/88_412-555-0119_type-2-diabetes_lab-results.pdf"]}'],
	["file-name-phone", "exports/2025-02/referrals/scan_6025550167_type-2-diabetes-mellitus_lab-results.pdf"],
	["file-name-phone", "scans/jane-doe_602-555-0167_lab-results.pdf"],
	["file-name-code", "exports/outbox/9921_KX4410927_asthma_referral.pdf"],
	["file-name-code", '{"files":["outbox/26874_SN-ZXWZGWCDY4_chronic-kidney-disease-stage_referral.pdf"]}'],
	["file-name-code", "scans/41837_203.0.113.93_diabetes-tipo-2_intake-form.pdf"],
	["file-name-code", "scans/512 4410_1922841151_copd_prior-auth.pdf"],
	["file-name-code", "exports/2025-03/scans/96402_010 427 114_human-immunodeficiency-virus-hiv_intake-form.pdf"],
];

it.effect.each(fires)("%s fires on %s", ([rule, text]) =>
	Effect.sync(() => {
		const hit = pipe(
			firstHit(text),
			Option.map((found) => found.rule),
		);

		assert.deepStrictEqual(hit, Option.some(rule));
	}),
);

const silent: readonly string[] = [
	"impossible SSNs 000-12-3456, 666-12-3456, 912-56-7823, 412-00-3456 and 412-56-0000",
	"ssn 078051120 has no dashes, and 1078-05-1120 is not one",
	"a digit where a letter belongs: 37R7-KX2-PN45, and an excluded S: 3SR7-KX2-PN45",
	`${msh}\rPID|1||00482913^^^MRN||||`,
	`${msh}\rPID|1||00482913^^^MRN||^^||`,
	String.raw`{"hl7": "${msh}\rPID|1||00482913^^^MRN||\rPV1|1|I"}`,
	'{"resourceType": "Observation", "subject": {"reference": "Patient/123"}, "valueQuantity": {"value": 7.2}}',
	'{"resourceType": "Patient", "id": "8812", "identifier": [{"system": "https://acme.example/patient-id", "value": "4471"}]}',
	'{"entry": [{"resource": {"resourceType": "Patient", "id": "8812"}}, {"resource": {"resourceType": "Practitioner", "name": [{"family": "Fakedoc"}]}}]}',
	'{"resourceType":"Patient","gender":"male"}',
	codedPatient("DL", ""),
	codedPatient("PI", "B3053196"),
	`{"resourceType": "Patient", "identifier": [{"type": ${coding("DL")}, "value": ""}, {"extension": [{"url": "https://example.org/note", "valueString": "${farFromCode}"}], "type": ${coding("PI")}, "value": "4471"}]}`,
	`${msh}\rPID|1||4471^^^NFH^PI|||||F`,
	'{"resourceType": "Practitioner", "telecom": [{"system": "phone", "value": "555-0142", "use": "work"}]}',
	'{"resourceType": "Device", "serialNumber": "SN-0042", "owner": {"reference": "Organization/7"}}',
	'{"resourceType": "Device", "serialNumber": "SN-0042"}, {"resourceType": "Observation", "subject": {"reference": "Patient/8812"}}',
	"exports/2025-03/eligibility/270_batch_0447.x12",
	"dist/2025_v2_release-notes.pdf",
	'{"resourceType": "Patient", "identifier": [{"type": {"coding": [{"code": "PI"}]}, "value": "PAT4471"}]}',
	'{"resourceType": "Patient", "identifier": [{"value": "PAT4471", "type": {"coding": [{"code": "PI"}]}}]}',
	'{"subject": {"type": "Patient", "reference": "Patient/8812"}, "telecom": [{"system": "phone", "value": "x1234"}]}',
	'{"resourceType": "Patient", "identifier": [{"system": "https://acme.example/patient-id", "value": "550e8400-e29b-41d4-a716-446655440000"}]}',
	"exports/2025-03/scans/96402_010 427 114 scan.pdf",
	'{"resourceType": "Patient", "name": [{"text": ""}], "gender": "female"}',
	`{"resourceType": "Encounter", "subject": {"reference": "Patient/8812"}, "contained": [{"resourceType": "Practitioner", "id": "p1", "identifier": [{"type": {"coding": [{"system": "${v20203}", "code": "DL"}]}, "value": "B3053196"}]}], "participant": [{"individual": {"reference": "#p1"}}]}`,
	header,
	`${header}NM1*IL*1~`,
	`${header}NM1*85*2*NORTHFIELD CLINIC*****XX*1234567893~`,
	"exports/outbox/9921_asthma_referral.pdf",
	"exports/2025-03/claims_batch_0447.csv",
	"logs/20250314_1200_export.log",
	"build/5035550147_bundle.js",
	"backups/db_1700000000_nightly.tar",
];

it.effect.each(silent)("no rule fires on %s", (text) =>
	Effect.sync(() => {
		assert.deepStrictEqual(firstHit(text), Option.none());
	}),
);
