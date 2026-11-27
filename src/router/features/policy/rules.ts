import { Array, Context, Option, pipe } from "effect";
import type { IdentifierKind } from "./policy.ts";

const hl7Field = String.raw`(?:[^|\r\n\\]|\\(?![rn]))*`;

const hl7Filled = String.raw`[^|\r\n\\\p{L}\p{N}]*[\p{L}\p{N}]`;

const memberSystem = String.raw`"system"\s*:\s*"[^"]*(?:ssn|mbi|medicare|member)[^"]*"`;

const filledValue = String.raw`"value"\s*:\s*"[^"\s]`;

const personalCode = String.raw`"code"\s*:\s*"(?:DL|PPN|DP|SS|MR|MRT|MB|SN|MA|MC)"`;

const ssn = /(?<![\w-])(?!000|666|9\d\d)\d{3}-(?!00)\d\d-(?!0000)\d{4}(?![\w-])/u;

const mbi =
	/(?<![\w-])[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y\d]\d-?[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y\d]\d-?[AC-HJKMNP-RT-Y]{2}\d\d(?![\w-])/u;

const hl7Pid = new RegExp(
	String.raw`MSH\|\^~\\&\|[\s\S]{0,4000}?(?:[^\p{L}\p{N}]|\\[rn])PID\|(?:${hl7Field}\|){4}(?:${hl7Filled}|${hl7Field}\|${hl7Field}\|${hl7Filled})`,
	"u",
);

const fhirPatient = new RegExp(
	String.raw`"resourceType"\s*:\s*"Patient"(?:(?!"resourceType")[\s\S]){0,3000}?(?:"birthDate"\s*:\s*"\d{4}-\d\d-\d\d"|"family"\s*:\s*"\p{L}|"given"\s*:\s*\[\s*"\p{L}|${memberSystem}[^{}]*?${filledValue}|${filledValue}[^"]*"[^{}]*?${memberSystem})`,
	"u",
);

const codeNear = 500;

const fhirCodedId = new RegExp(
	String.raw`^(?=[\s\S]*"resourceType"\s*:\s*"Patient")[\s\S]*?(?:${personalCode}[\s\S]{0,${String(codeNear)}}?${filledValue}|${filledValue}[\s\S]{0,${String(codeNear)}}?${personalCode})`,
	"u",
);

const x12Member = /ISA\*[\s\S]{0,4000}?NM1\*(?:IL|QC)\*[12]\*(?:\p{L}|(?:[^*~\r\n]*\*){6}[\p{L}\p{N}])/u;

const fileNamePhone =
	/(?<=[\p{L}\p{N}-]_)(?:\([2-9]\d\d\) ?|[2-9]\d\d[ .-]?)[2-9]\d\d[ .-]?\d{4}_[\p{L}\p{N}_-]*\p{L}[\p{L}\p{N}_-]*\.[A-Za-z]{2,5}(?!\w)/u;

interface Rule {
	readonly id: string;
	readonly kind: IdentifierKind;
	readonly pattern: Readonly<RegExp>;
}

const rules = [
	{ id: "ssn", kind: "ssn", pattern: ssn },
	{ id: "mbi", kind: "medicare-medicaid-number", pattern: mbi },
	{ id: "hl7-pid", kind: "patient-name", pattern: hl7Pid },
	{ id: "fhir-patient", kind: "patient-name", pattern: fhirPatient },
	{ id: "fhir-coded-id", kind: "patient-name", pattern: fhirCodedId },
	{ id: "x12-member", kind: "member-number", pattern: x12Member },
	{ id: "file-name-phone", kind: "personal-phone", pattern: fileNamePhone },
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
