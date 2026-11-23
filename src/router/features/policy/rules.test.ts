import { Array, Clock, Effect, Option, String as Str, pipe } from "effect";
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

/** Farther from the Patient marker than the 3,000 characters `fhir-patient` reads past it. */
const pastPatientReach = 3100;

const farFromPatient = Str.repeat(pastPatientReach)("A");

/** Farther from a listed code than the 500 characters `fhir-coded-id` looks for a filled value. */
const pastCodeReach = 600;

const farFromCode = Str.repeat(pastCodeReach)("A");

const codedFires = pipe(
	["DL", "PPN", "DP", "SS", "MR", "MRT", "MB", "SN", "MA", "MC"],
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
	...codedFires,
	...codedLayouts,
	["x12-member", `${header}NM1*IL*1*FAKESMITH*CANARY****MI*XGH492817305~`],
	["x12-member", `${header}NM1*QC*1******MI*XGH492817305~`],
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
	'{"resourceType": "Observation", "subject": {"reference": "Patient/123"}, "valueQuantity": {"value": 7.2}}',
	'{"resourceType": "Patient", "id": "8812", "identifier": [{"system": "https://acme.example/patient-id", "value": "4471"}]}',
	'{"entry": [{"resource": {"resourceType": "Patient", "id": "8812"}}, {"resource": {"resourceType": "Practitioner", "name": [{"family": "Fakedoc"}]}}]}',
	'{"resourceType":"Patient","gender":"male"}',
	codedPatient("DL", ""),
	codedPatient("PI", "B3053196"),
	`{"resourceType": "Patient", "identifier": [{"type": ${coding("DL")}, "value": ""}], "text": {"div": "<div>${farFromCode}</div>"}, "telecom": [{"system": "phone", "value": "555-0142"}]}`,
	`{"resourceType": "Encounter", "subject": {"reference": "Patient/8812"}, "contained": [{"resourceType": "Practitioner", "id": "p1", "identifier": [{"type": {"coding": [{"system": "${v20203}", "code": "DL"}]}, "value": "B3053196"}]}], "participant": [{"individual": {"reference": "#p1"}}]}`,
	header,
	`${header}NM1*IL*1~`,
	`${header}NM1*85*2*NORTHFIELD CLINIC*****XX*1234567893~`,
];

it.effect.each(silent)("no rule fires on %s", (text) =>
	Effect.sync(() => {
		assert.deepStrictEqual(firstHit(text), Option.none());
	}),
);

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
