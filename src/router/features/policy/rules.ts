import { Array, Context, Option, pipe } from "effect";
import type { IdentifierKind } from "./policy.ts";

const hl7Field = String.raw`(?:[^|\r\n\\]|\\(?![rn]))*`;

const hl7Filled = String.raw`[^|\r\n\\\p{L}\p{N}]*[\p{L}\p{N}]`;

const hl7TypedId = String.raw`[^|~^\r\n\\]+(?:\^[^|~^\r\n\\]*){3}\^(?!PI(?![\p{L}\p{N}]))\p{Lu}`;

const personalSystem = String.raw`"system"\s*:\s*"[^"]*(?:ssn|mbi|medicare|member|passport|licen[cs]e|account|vehicle|device)[^"]*"`;

const patientResource = String.raw`"\p{L}{10,14}"\s*:\s*"Patient"`;

const filledValue = String.raw`"value"\s*:\s*"[^"\s]`;

const codeNear = 500;

const untypedField = String.raw`(?:(?!"type")[^{}]){0,${String(codeNear)}}`;

const untypedCode = String.raw`"identifier"\s*:\s*\[[^\]]{0,${String(codeNear)}}?\{${untypedField}?"(?=[A-Z\d-]{6,}")(?=[A-Z-]*\d)(?=[\d-]*[A-Z])${untypedField}\}`;

const personalCode = String.raw`"code"\s*:\s*"(?:DL|PPN|DP|SS|MR|MRT|MB|SN|MA|MC|AN|BCT)"`;

const ssn = /(?<![\w-])(?!000|666|9\d\d)\d{3}-(?!00)\d\d-(?!0000)\d{4}(?![\w-])/u;

const mbi =
	/(?<![\w-])[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y\d]\d-?[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y\d]\d-?[AC-HJKMNP-RT-Y]{2}\d\d(?![\w-])/u;

const hl7Pid = new RegExp(
	String.raw`MSH\|\^~\\{1,2}&\|[\s\S]{0,4000}?(?:[^\p{L}\p{N}]|\\[rn])PID\|(?:(?:${hl7Field}\|){4}(?:${hl7Filled}|${hl7Field}\|${hl7Field}\|${hl7Filled})|${hl7Field}\|${hl7Field}\|(?:[^|\r\n\\]*~)?${hl7TypedId})`,
	"u",
);

const fhirPatient = new RegExp(
	String.raw`${patientResource}(?:(?!"resourceType")[\s\S]){0,3000}?(?:"birthDate"\s*:\s*"\d{4}-\d\d-\d\d"|"family"\s*:\s*"\p{L}|"given"\s*:\s*\[\s*"\p{L}|"name"\s*:\s*\[[^\]]{0,${String(codeNear)}}?"text"\s*:\s*"\p{L}|"telecom"\s*:\s*\[[^\]]{0,${String(codeNear)}}?${filledValue}|${untypedCode}|${personalSystem}[^{}]*?${filledValue}|${filledValue}[^"]*"[^{}]*?${personalSystem})`,
	"u",
);

const fhirCodedId = new RegExp(
	String.raw`^(?=[\s\S]*${patientResource})[\s\S]*?(?:${personalCode}[\s\S]{0,${String(codeNear)}}?${filledValue}|${filledValue}[\s\S]{0,${String(codeNear)}}?${personalCode})`,
	"u",
);

const deviceNear = 300;

const patientReference = String.raw`"patient"\s*:\s*\{\s*"reference"\s*:\s*"[^"\s]`;

const serialNumber = String.raw`"serialNumber"\s*:\s*"[^"\s]`;

const fhirPatientDevice = new RegExp(
	String.raw`${serialNumber}[^{}]{0,${String(deviceNear)}}?${patientReference}|${patientReference}[^"]*"\s*\}[^{}]{0,${String(deviceNear)}}?${serialNumber}`,
	"u",
);

const x12Member = /ISA\*[\s\S]{0,4000}?NM1\*(?:IL|QC)\*[12]\*(?:\p{L}|(?:[^*~\r\n]*\*){6}[\p{L}\p{N}])/u;

const fileNamePhone =
	/(?<=[\p{L}\p{N}-]_)(?:\([2-9]\d\d\) ?|[2-9]\d\d[ .-]?)[2-9]\d\d[ .-]?\d{4}_[\p{L}\p{N}_-]*\p{L}[\p{L}\p{N}_-]*\.[A-Za-z]{2,5}(?!\w)/u;

const fileNameCode =
	/(?<=(?:^|[\s/"'])\d+_)[^\s/_"'\d]{0,40}\d(?:[^\s/_"']|(?<=\d) (?=\d)){0,40}_[\p{N}-]*\p{L}[\p{L}\p{N}-]*_[\p{N}_-]*\p{L}[\p{L}\p{N}_-]*\.[A-Za-z]{2,5}(?!\w)/u;

interface Rule {
	readonly id: string;
	readonly kind: IdentifierKind;
	readonly pattern: Readonly<RegExp>;
}

const rules = [
	{ id: "ssn", kind: "ssn", pattern: ssn },
	{ id: "mbi", kind: "medicare-medicaid-number", pattern: mbi },
	{ id: "hl7-pid", kind: "patient-name", pattern: hl7Pid },
	{ id: "fhir-coded-id", kind: "patient-name", pattern: fhirCodedId },
	{ id: "fhir-patient", kind: "patient-name", pattern: fhirPatient },
	{ id: "fhir-patient-device", kind: "device-identifier", pattern: fhirPatientDevice },
	{ id: "x12-member", kind: "member-number", pattern: x12Member },
	{ id: "file-name-phone", kind: "personal-phone", pattern: fileNamePhone },
	{ id: "file-name-code", kind: "mrn", pattern: fileNameCode },
] as const satisfies readonly Rule[];

type RuleId = (typeof rules)[number]["id"];

type PolicyRule = Rule & { readonly id: RuleId };

const Rules = Context.Reference<readonly PolicyRule[]>("phi-router/router/features/policy/Rules", {
	defaultValue: () => rules,
});

interface RuleHit {
	readonly rule: RuleId;
	readonly kind: IdentifierKind;
}

const firstHitOf =
	(active: readonly PolicyRule[]) =>
	(text: string): Option.Option<RuleHit> =>
		pipe(
			active,
			Array.findFirst(({ pattern }) => pattern.test(text)),
			Option.map(({ id, kind }) => ({ kind, rule: id })),
		);

const firstHit = firstHitOf(rules);

export { Rules, firstHit, firstHitOf, rules };

export type { Rule, RuleId };
