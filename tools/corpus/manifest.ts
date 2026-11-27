import { Array, Schema, pipe } from "effect";
import { identifierKind, identifierKindNames } from "#router/features/policy/index.ts";
import type { IdentifierKind } from "#router/features/policy/index.ts";

type Uncovered = typeof identifierKind.biometricIdentifier;

type CoveredIdentifier = Exclude<IdentifierKind, Uncovered>;

type TextIdentifier = Exclude<CoveredIdentifier, typeof identifierKind.facePhoto>;

const coveredKinds = pipe(
	identifierKindNames,
	Array.filter((kind): kind is CoveredIdentifier => kind !== identifierKind.biometricIdentifier),
);

const TextIdentifiers = Schema.Literals(
	pipe(
		coveredKinds,
		Array.filter((kind): kind is TextIdentifier => kind !== identifierKind.facePhoto),
	),
);

const Identifier = Schema.Literals(coveredKinds);

const firstTextKinds: Array.NonEmptyReadonlyArray<TextIdentifier> = [
	identifierKind.patientName,
	identifierKind.socialSecurityNumber,
	identifierKind.birthDate,
	identifierKind.streetAddress,
	identifierKind.personalPhone,
	identifierKind.personalEmail,
	identifierKind.memberNumber,
	identifierKind.medicareMedicaidNumber,
	identifierKind.medicalRecordNumber,
	identifierKind.driverLicense,
	identifierKind.passportNumber,
];

const addedTextKinds: Array.NonEmptyReadonlyArray<TextIdentifier> = [
	identifierKind.geographicDetail,
	identifierKind.personalFax,
	identifierKind.personalUrl,
	identifierKind.ipAddress,
	identifierKind.accountNumber,
	identifierKind.certificateLicense,
	identifierKind.vehicleIdentifier,
	identifierKind.deviceIdentifier,
	identifierKind.patientDate,
	identifierKind.claimNumber,
];

const TextCarriers = Schema.Literals([
	"sql-dump",
	"csv",
	"fhir-json",
	"hl7v2",
	"x12-837",
	"log-line",
	"stack-trace",
	"clinical-note",
	"ticket",
	"git-diff",
	"file-name",
]);

type TextCarrier = typeof TextCarriers.Type;

const Carrier = Schema.Literals([...TextCarriers.literals, "screenshot"]);

const Transform = Schema.Literals([
	"plain",
	"base64",
	"gzip-hex",
	"split",
	"buried",
	"minified",
	"non-english",
	"typos",
]);

const Entry = Schema.Literals(["user", "tool-result", "file-read", "steering", "compaction-summary", "ent-reply"]);

const Negative = Schema.Literals([
	"schema-only",
	"medical-terms",
	"public-figure",
	"look-alike",
	"internal-id",
	"internal-id-health",
	"synthetic-listed",
	"staff-contact",
	"fragment",
	"count",
	"clean-screenshot",
]);

const Role = Schema.Literals(["system", "user", "assistant", "tool"]);

const Image = Schema.Struct({ mimeType: Schema.String, data: Schema.String });

const TextMessage = Schema.Struct({ role: Role, text: Schema.String });

const ImageMessage = Schema.Struct({ role: Role, image: Image });

const Messages = Schema.NonEmptyArray(Schema.Union([TextMessage, ImageMessage]));

type Message = (typeof Messages.Type)[number];

const minCanaryLength = 8;

const Canary = Schema.String.check(Schema.isMinLength(minCanaryLength));

const minFragmentLength = 6;

const Fragment = Schema.String.check(Schema.isMinLength(minFragmentLength));

const CanaryParts = Schema.Record(Schema.String, Schema.NonEmptyArray(Schema.String));

const PhiCaseStrata = Schema.Struct({ identifier: Identifier, carrier: Carrier, transform: Transform, entry: Entry });

const PhiCase = Schema.Struct({
	id: Schema.String,
	expect: Schema.Literal("phi"),
	strata: PhiCaseStrata,
	canaries: Schema.NonEmptyArray(Canary),
	canaryParts: Schema.optionalKey(CanaryParts),
	fragments: Schema.Array(Fragment),
	messages: Messages,
});

type PhiStrata = (typeof PhiCase.Type)["strata"];

const CleanCase = Schema.Struct({
	id: Schema.String,
	expect: Schema.Literal("clean"),
	strata: Schema.Struct({ negative: Negative }),
	canaries: Schema.Tuple([]),
	fragments: Schema.Array(Fragment),
	messages: Messages,
});

const PhiOrCleanCase = Schema.Union([PhiCase, CleanCase]);

type Case = typeof PhiOrCleanCase.Type;

const CaseFromJsonLine = Schema.fromJsonString(PhiOrCleanCase);

const SyntheticIdentities = Schema.Struct({
	exact: Schema.Array(Schema.String),
	prefixes: Schema.Array(Schema.String),
});

type Synthetic = typeof SyntheticIdentities.Type;

type Part =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "image"; readonly mimeType: string; readonly data: string };

interface Turn {
	readonly role: Message["role"];
	readonly parts: readonly Part[];
}

type Transcript = readonly Turn[];

const turnOf = (message: Message): Turn => {
	if ("text" in message) {
		return { parts: [{ kind: "text", text: message.text }], role: message.role };
	}

	const { data, mimeType } = message.image;

	return { parts: [{ data, kind: "image", mimeType }], role: message.role };
};

const transcriptOf = (messages: readonly Message[]): Transcript => pipe(messages, Array.map(turnOf));

export {
	Carrier,
	addedTextKinds,
	firstTextKinds,
	CaseFromJsonLine,
	CleanCase,
	Entry,
	Identifier,
	Negative,
	PhiCase,
	SyntheticIdentities,
	TextCarriers,
	TextIdentifiers,
	Transform,
	transcriptOf,
};

export type { Case, Message, Part, PhiStrata, Synthetic, TextCarrier, TextIdentifier, Transcript, Turn };
