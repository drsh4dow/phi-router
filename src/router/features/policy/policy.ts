import { Array, pipe } from "effect";

const identifierKind = {
	accountNumber: "account-number",
	biometricIdentifier: "biometric",
	birthDate: "birth-date",
	certificateLicense: "certificate-license",
	claimNumber: "claim-number",
	deviceIdentifier: "device-identifier",
	driverLicense: "driver-license",
	facePhoto: "face-photo",
	geographicDetail: "geographic-detail",
	ipAddress: "ip-address",
	medicalRecordNumber: "mrn",
	medicareMedicaidNumber: "medicare-medicaid-number",
	memberNumber: "member-number",
	passportNumber: "passport",
	patientDate: "patient-date",
	patientName: "patient-name",
	personalEmail: "personal-email",
	personalFax: "personal-fax",
	personalPhone: "personal-phone",
	personalUrl: "personal-url",
	socialSecurityNumber: "ssn",
	streetAddress: "street-address",
	vehicleIdentifier: "vehicle-identifier",
} as const;

const identifierKinds = [
	[identifierKind.patientName, "a real patient's or member's name"],
	[identifierKind.socialSecurityNumber, "a Social Security number"],
	[identifierKind.birthDate, "a full date of birth"],
	[identifierKind.patientDate, "a patient's date of service, admission, discharge or death, with more than its year"],
	[identifierKind.streetAddress, "a home street address"],
	[
		identifierKind.geographicDetail,
		"the city, county, ZIP code or geocode of where a patient lives (the first three digits of a ZIP code alone do not count)",
	],
	[identifierKind.personalPhone, "a personal phone number"],
	[identifierKind.personalFax, "a personal fax number"],
	[identifierKind.personalEmail, "a personal email address"],
	[identifierKind.personalUrl, "a URL of a patient's own web page or profile"],
	[identifierKind.ipAddress, "an IP address of a patient's device or connection"],
	[identifierKind.memberNumber, "an insurance member or subscriber number"],
	[identifierKind.medicareMedicaidNumber, "a Medicare or Medicaid number"],
	[identifierKind.medicalRecordNumber, "a provider's medical record number"],
	[identifierKind.claimNumber, "a claim, encounter or prior authorization number of a patient"],
	[identifierKind.accountNumber, "a patient's account number, such as a billing or a patient account number"],
	[identifierKind.driverLicense, "a driver license number"],
	[
		identifierKind.certificateLicense,
		"another certificate or license number of a patient, such as a birth certificate number",
	],
	[identifierKind.passportNumber, "a passport number"],
	[identifierKind.vehicleIdentifier, "a patient's vehicle identification number or license plate"],
	[identifierKind.deviceIdentifier, "a serial number or device identifier of a patient's device, such as an implant"],
	[identifierKind.biometricIdentifier, "a patient's fingerprint, voiceprint or other biometric identifier"],
	[identifierKind.facePhoto, "a face photo, or an image that shows any of these"],
] as const;

type IdentifierKind = (typeof identifierKinds)[number] extends readonly [infer Kind, string] ? Kind : never;

const identifierKindNames: readonly IdentifierKind[] = pipe(
	identifierKinds,
	Array.map(([kind]) => kind),
);

const defaults = [
	"Insurance member numbers and a provider's medical record numbers count.",
	"A real patient's or member's name counts even with no health facts.",
	"A date tied to a patient counts when it holds more than its year: a date of service, admission, discharge or death, as well as a date of birth. An age over 89 counts.",
	"A claim, encounter or prior authorization number counts, since a payer or provider assigned it to one patient.",
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
	readonly prefixes: readonly string[];
}

const syntheticIdentities: SyntheticIdentities = { exact: [], prefixes: [] };

const syntheticMark = "[synthetic-id]";

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

const notIdentifiers = `Not direct identifiers: internal ids, health facts tied only to an internal id, code, schemas, logs and SQL, staff, vendor and business contacts, fragments, counts. For example: ${counterList}.`;

const rewriteLimit = 5;

const wayOut = (filesFolder: string): string =>
	`Refer to each person by an internal id such as a patient_id or a row id, give counts instead of lists of people, and when the user needs the identifiers themselves, write them to a new file in ${filesFolder} with mode 0600 and answer with the file's absolute path and a summary that holds none of them.`;

const pinnedInstructionsOf = (filesFolder: string): string =>
	Array.join(
		[
			"phi-router: you are the pinned subagent. You run on the HIPAA account and can read patient identifiers. A part shown between [content of hN] and [end of hN] is the sealed part with handle hN, which phi-router put back for you.",
			"phi-router checks your last answer before the agent that started you reads it, and that agent runs on an account that must never see patient identifiers. Your last answer must hold no direct identifier of a patient or health-plan member.",
			`Direct identifiers: ${kindList}.`,
			...defaults,
			notIdentifiers,
			wayOut(filesFolder),
			`An answer that still holds an identifier comes back to you with the reason, up to ${String(rewriteLimit)} times. After that phi-router withholds it, and the agent that started you gets only its handle.`,
		],
		" ",
	);

const countingRules = [
	`Direct identifiers: ${kindList}.`,
	...defaults,
	"An image counts only when it shows a face or one of these identifiers.",
	`${syntheticMark} marks a listed test identity that was removed; it identifies no one.`,
	`Treat every other value as a real person's: a value that looks invented, a placeholder, an example domain or a reserved number range still counts.`,
	"A name, phone, email, address, date of birth or record or member number that could belong to a patient or member counts, wherever it appears (a file name, a log, a table, a header). Clear it only when the text shows it belongs to staff, a vendor or a business.",
	"In a path or file name that names a diagnosis or a patient's document, in any language, every number or code other than a leading internal id counts, whatever its spacing or mix of letters and digits: in `9921_KX4410927_asthma_referral.pdf` or `9921_AW20831C_asma_referral.pdf` the second value counts, while `9921_asthma_referral.pdf` holds only an internal id.",
	"Encoded, minified, misspelled or buried values count.",
	notIdentifiers,
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

const thresholds = { clearBelow: 0.2, sealAtOrAbove: 0.5 } as const;

const quoteMinChars = 16;

const seamChars = 200;

const window = 0;

interface JudgeCallLimits {
	readonly maxChars: number;
	readonly maxImages: number;
	readonly timeoutMs: number;
}

const judgeLimits: JudgeCallLimits = { maxChars: 2_000_000, maxImages: 128, timeoutMs: 20_000 };

export {
	counterExamples,
	defaults,
	identifierKind,
	identifierKindNames,
	identifierKinds,
	identifierQuestion,
	judgeLimits,
	kindQuestion,
	pinnedInstructionsOf,
	quoteMinChars,
	rewriteLimit,
	seamChars,
	stubs,
	syntheticIdentities,
	syntheticMark,
	thresholds,
	wayOut,
	window,
};

export type { IdentifierKind, SyntheticIdentities };
