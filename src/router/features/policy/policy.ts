import { Array, pipe } from "effect";

/** Each identifier kind under a name code outside the policy can spell, so no other file spells a kind. */
const identifierKind = {
	birthDate: "birth-date",
	driverLicense: "driver-license",
	facePhoto: "face-photo",
	medicalRecordNumber: "mrn",
	medicareMedicaidNumber: "medicare-medicaid-number",
	memberNumber: "member-number",
	passportNumber: "passport",
	patientName: "patient-name",
	personalEmail: "personal-email",
	personalPhone: "personal-phone",
	socialSecurityNumber: "ssn",
	streetAddress: "street-address",
} as const;

/** Each kind in the order the judge reads it. */
const identifierKinds = [
	[identifierKind.patientName, "a real patient's or member's name"],
	[identifierKind.socialSecurityNumber, "a Social Security number"],
	[identifierKind.birthDate, "a full date of birth"],
	[identifierKind.streetAddress, "a home street address"],
	[identifierKind.personalPhone, "a personal phone number"],
	[identifierKind.personalEmail, "a personal email address"],
	[identifierKind.memberNumber, "an insurance member or subscriber number"],
	[identifierKind.medicareMedicaidNumber, "a Medicare or Medicaid number"],
	[identifierKind.medicalRecordNumber, "a provider's medical record number"],
	[identifierKind.driverLicense, "a driver license number"],
	[identifierKind.passportNumber, "a passport number"],
	[identifierKind.facePhoto, "a face photo, or an image that shows any of these"],
] as const;

type IdentifierKind = (typeof identifierKinds)[number] extends readonly [infer Kind, string] ? Kind : never;

const identifierKindNames: readonly IdentifierKind[] = pipe(
	identifierKinds,
	Array.map(([kind]) => kind),
);

/** The plan's defaults the human can change. Edit the sentence; the judge reads it as written. */
const defaults = [
	"Insurance member numbers and a provider's medical record numbers count.",
	"A real patient's or member's name counts even with no health facts.",
	"Clinical dates other than a date of birth count only next to a direct identifier of the same person.",
] as const;

const counterExamples = [
	{ text: "patient_id 4471, asthma, sync failed at step 3", why: "a health fact tied only to an internal id" },
	{ text: "SELECT patient_id, dx_code FROM encounters WHERE client_code = 'C-102'", why: "schema and SQL" },
	{ text: "row 88123, uuid 550e8400-e29b-41d4-a716-446655440000", why: "internal ids" },
	{ text: "Ask Dana Whitfield (vendor support), dana@vendor.example", why: "a vendor contact" },
	{ text: "Dr. Ruth Okafor, cardiology, ext. 4410", why: "a staff contact" },
	{ text: "...son, DOB 19", why: "a fragment" },
	{ text: "412 members had a claim denied in March", why: "a count" },
] as const;

interface SyntheticIdentities {
	readonly exact: readonly string[];
	/** A token that starts with one of these is a test identity, such as a staging client code. */
	readonly prefixes: readonly string[];
}

const syntheticIdentities: SyntheticIdentities = { exact: [], prefixes: [] };

const syntheticMark = "[synthetic-id]";

/** Constant per class, so a stub never changes and an open account's cache prefix stays stable. */
const stubs = {
	sealed: "[withheld: holds patient identifiers, handled on the HIPAA account]",
	unknown: "[withheld: not checked for patient identifiers]",
} as const;

const readingRules = `\`piece\` is new content from a developer's session with a coding agent: a message, pasted text, tool or file output, or part of a system prompt. \`context\` is earlier content that already cleared, for reading only: judge \`piece\`, not \`context\`. ${stubs.sealed} in \`context\` stands for earlier content that was withheld.`;

const kindList = pipe(
	identifierKinds,
	Array.map(([, description]) => description),
	Array.join("; "),
);

const counterList = pipe(
	counterExamples,
	Array.map(({ text, why }) => `"${text}" (${why})`),
	Array.join("; "),
);

/** What counts and what does not. Both questions carry it, so the band's kind answer applies the same policy. */
const countingRules = [
	`Direct identifiers: ${kindList}.`,
	...defaults,
	"An image counts only when it shows a face or one of these identifiers.",
	`${syntheticMark} marks a listed test identity that was removed; it identifies no one.`,
	`Treat every other value as a real person's: a value that looks invented, a placeholder, an example domain or a reserved number range still counts.`,
	"A name, phone, email, address, date of birth or record or member number that could belong to a patient or member counts, wherever it appears (a file name, a log, a table, a header). Clear it only when the text shows it belongs to staff, a vendor or a business.",
	"In a path or file name that names a diagnosis or a patient's document, in any language, every number or code other than a leading internal id counts, whatever its spacing or mix of letters and digits: in `9921_KX4410927_asthma_referral.pdf` or `9921_AW20831C_asma_referral.pdf` the second value counts, while `9921_asthma_referral.pdf` holds only an internal id.",
	"Encoded, minified, misspelled or buried values count.",
	`Not direct identifiers: internal ids, health facts tied only to an internal id, code, schemas, logs and SQL, staff, vendor and business contacts, fragments, counts. For example: ${counterList}.`,
];

const identifierQuestion = {
	criteria: {
		false: `\`piece\` holds no complete direct identifier of a patient or member: only internal ids, code, schemas, staff or vendor contacts, fragments, counts or values shown as ${syntheticMark}.`,
		true: "`piece` holds, or likely holds, a complete direct identifier that could belong to a patient or member.",
	},
	instructions: Array.join(
		[
			readingRules,
			"Does `piece` contain a complete direct identifier of a real patient or health-plan member?",
			...countingRules,
		],
		" ",
	),
	type: "bool",
} as const;

const kindQuestion = {
	criteria: [...identifierKinds, ["none", "no direct identifier of a real patient or member"]],
	instructions: Array.join(
		[
			readingRules,
			"Which direct identifier of a real patient or member does `piece` contain? Answer none only when it holds none. A number or code that counts in a document's file name is a record or member number when nothing says which.",
			...countingRules,
		],
		" ",
	),
	type: "choice",
} as const;

/**
 * Each judge's thresholds, from its own calibration on the default corpus (ADR 0009). `p < clearBelow` clears and
 * `p >= sealAtOrAbove` seals. In between, the kind question decides. A system part seals only at or above
 * `sealAtOrAbove` with a named kind.
 */
const thresholds = {
	claude: { clearBelow: 0.05, sealAtOrAbove: 0.5 },
	decisions: { clearBelow: 0.2, sealAtOrAbove: 0.5 },
} as const;

type JudgeName = keyof typeof thresholds;

/** The shortest line, trimmed, that counts as a BAA account's reply repeating sealed content. */
const quoteMinChars = 16;

const seamChars = 200;

/**
 * How many preceding rendered items the judge sees beside a piece. For a tool result the first is its own call. None:
 * on the v2 corpus, context never caught a leak that no context missed, made a screenshot score lower, and cost more.
 */
const window = 0;

/** Decisions' limits: characters per call, images per call, and how long one call may take. */
const judgeLimits = { maxChars: 2_000_000, maxImages: 128, timeoutMs: 20_000 } as const;

export {
	counterExamples,
	defaults,
	identifierKind,
	identifierKindNames,
	identifierKinds,
	identifierQuestion,
	judgeLimits,
	kindQuestion,
	quoteMinChars,
	seamChars,
	stubs,
	syntheticIdentities,
	syntheticMark,
	thresholds,
	window,
};

export type { IdentifierKind, JudgeName, SyntheticIdentities };
