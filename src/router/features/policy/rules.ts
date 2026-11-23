import { Array, Context, Option, pipe } from "effect";
import type { IdentifierKind } from "./policy.ts";

/** One HL7 v2 field: anything up to the next `|` or segment end, a literal `\r` or `\n` in serialized text included. */
const hl7Field = String.raw`(?:[^|\r\n\\]|\\(?![rn]))*`;

/** An HL7 v2 field holding a letter or digit, not only component separators such as `^^`. */
const hl7Filled = String.raw`[^|\r\n\\\p{L}\p{N}]*[\p{L}\p{N}]`;

const memberSystem = String.raw`"system"\s*:\s*"[^"]*(?:ssn|mbi|medicare|member)[^"]*"`;

const filledValue = String.raw`"value"\s*:\s*"[^"\s]`;

/**
 * An HL7 v2-0203 identifier type code that names a personal identifier: DL driver-license, PPN and DP passport, SS ssn,
 * MR and MRT mrn, MB and SN member-number, MA and MC medicare-medicaid-number.
 */
const personalCode = String.raw`"code"\s*:\s*"(?:DL|PPN|DP|SS|MR|MRT|MB|SN|MA|MC)"`;

/** The SSA never issues area 000, 666 or 9xx, group 00 or serial 0000. */
const ssn = /(?<![\w-])(?!000|666|9\d\d)\d{3}-(?!00)\d\d-(?!0000)\d{4}(?![\w-])/u;

const mbi =
	/(?<![\w-])[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y\d]\d-?[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y\d]\d-?[AC-HJKMNP-RT-Y]{2}\d\d(?![\w-])/u;

/** A PID segment whose PID-5 (name) or PID-7 (birth date) is filled. PID-3 alone is often an internal handle. */
const hl7Pid = new RegExp(
	String.raw`MSH\|\^~\\&\|[\s\S]{0,4000}?(?:[^\p{L}\p{N}]|\\[rn])PID\|(?:${hl7Field}\|){4}(?:${hl7Filled}|${hl7Field}\|${hl7Field}\|${hl7Filled})`,
	"u",
);

/** Within one Patient resource. A resource that only references `Patient/<id>` is not one. */
const fhirPatient = new RegExp(
	String.raw`"resourceType"\s*:\s*"Patient"(?:(?!"resourceType")[\s\S]){0,3000}?(?:"birthDate"\s*:\s*"\d{4}-\d\d-\d\d"|"family"\s*:\s*"\p{L}|"given"\s*:\s*\[\s*"\p{L}|${memberSystem}[^{}]*?${filledValue}|${filledValue}[^"]*"[^{}]*?${memberSystem})`,
	"u",
);

/** Characters between a listed code and a filled `value`, wide enough for an `extension` between them. */
const codeNear = 500;

/**
 * A Patient resource anywhere in the text, and a listed code with a filled `value` within `codeNear` characters on
 * either side. A regular expression cannot follow JSON, so member order, nesting and the distance from the Patient do
 * not matter, and a Patient beside another resource's coded identifier seals too. Anchored at the start, so each
 * part scans the text once.
 */
const fhirCodedId = new RegExp(
	String.raw`^(?=[\s\S]*"resourceType"\s*:\s*"Patient")[\s\S]*?(?:${personalCode}[\s\S]{0,${String(codeNear)}}?${filledValue}|${filledValue}[\s\S]{0,${String(codeNear)}}?${personalCode})`,
	"u",
);

/** NM1 subscriber or patient with a filled last name (NM103) or member id (NM109), inside an ISA envelope. */
const x12Member = /ISA\*[\s\S]{0,4000}?NM1\*(?:IL|QC)\*[12]\*(?:\p{L}|(?:[^*~\r\n]*\*){6}[\p{L}\p{N}])/u;

interface Rule {
	readonly id: string;
	readonly kind: IdentifierKind;
	readonly pattern: Readonly<RegExp>;
}

/**
 * Rules for unambiguous direct identifiers only. A hit seals; rules never clear. Each rule is its pattern alone, so
 * `policyVersion`, which hashes every pattern, changes whenever a rule does.
 */
const rules = [
	{ id: "ssn", kind: "ssn", pattern: ssn },
	{ id: "mbi", kind: "medicare-medicaid-number", pattern: mbi },
	{ id: "hl7-pid", kind: "patient-name", pattern: hl7Pid },
	{ id: "fhir-patient", kind: "patient-name", pattern: fhirPatient },
	{ id: "fhir-coded-id", kind: "patient-name", pattern: fhirCodedId },
	{ id: "x12-member", kind: "member-number", pattern: x12Member },
] as const satisfies readonly Rule[];

type RuleId = (typeof rules)[number]["id"];

/** One of the policy's own rules. */
type PolicyRule = Rule & { readonly id: RuleId };

/** The rules the engine applies. Unprovided, every rule of the policy; a test provides fewer to see what one catches. */
const Rules = Context.Reference<readonly PolicyRule[]>("phi-router/router/features/policy/Rules", {
	defaultValue: () => rules,
});

interface RuleHit {
	readonly rule: RuleId;
	readonly kind: IdentifierKind;
}

/**
 * The first of `active` that fires on a text: a piece's text with its decoded readings, after synthetic blanking.
 *
 * @param {readonly Rule[]} active The rules to apply.
 * @returns {Function} The rule's id and kind for a text, or none.
 */
const firstHitOf =
	(active: readonly PolicyRule[]) =>
	(text: string): Option.Option<RuleHit> =>
		pipe(
			active,
			Array.findFirst(({ pattern }) => pattern.test(text)),
			Option.map(({ id, kind }) => ({ kind, rule: id })),
		);

/** The first rule of the policy that fires on a text. */
const firstHit = firstHitOf(rules);

export { Rules, firstHit, firstHitOf, rules };

export type { Rule, RuleId };
