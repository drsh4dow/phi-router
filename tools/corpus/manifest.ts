import { Array, Schema, pipe } from "effect";
import { identifierKind, identifierKindNames } from "#router/features/policy/index.ts";
import type { IdentifierKind } from "#router/features/policy/index.ts";

type TextIdentifier = Exclude<IdentifierKind, typeof identifierKind.facePhoto>;

/** The identifier kinds a text carries, in the policy's order. */
const TextIdentifiers = Schema.Literals(
	pipe(
		identifierKindNames,
		Array.filter((kind): kind is TextIdentifier => kind !== identifierKind.facePhoto),
	),
);

const Identifier = Schema.Literals(identifierKindNames);

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

/**
 * A struct encodes its fields in the order they were added, and that order is the manifest's. So a struct whose fields
 * are not in sorted order adds them one at a time.
 */
const Image = pipe(Schema.Struct({ mimeType: Schema.String }), Schema.fieldsAssign({ data: Schema.String }));

const TextMessage = Schema.Struct({ role: Role, text: Schema.String });

const ImageMessage = pipe(Schema.Struct({ role: Role }), Schema.fieldsAssign({ image: Image }));

const Messages = Schema.NonEmptyArray(Schema.Union([TextMessage, ImageMessage]));

type Message = (typeof Messages.Type)[number];

const minCanaryLength = 8;

const Canary = Schema.String.check(Schema.isMinLength(minCanaryLength));

const minFragmentLength = 6;

/** A partial identifier planted on purpose: reported when it reaches an open account, never a leak. */
const Fragment = Schema.String.check(Schema.isMinLength(minFragmentLength));

const CanaryParts = Schema.Record(Schema.String, Schema.NonEmptyArray(Schema.String));

const PhiCaseStrata = pipe(
	Schema.Struct({ identifier: Identifier }),
	Schema.fieldsAssign({ carrier: Carrier }),
	Schema.fieldsAssign({ transform: Transform }),
	Schema.fieldsAssign({ entry: Entry }),
);

/** A case that holds PHI. For a `split` case, `canaryParts` gives each cut canary's parts in message order. */
const PhiCase = pipe(
	Schema.Struct({ id: Schema.String }),
	Schema.fieldsAssign({ expect: Schema.Literal("phi") }),
	Schema.fieldsAssign({ strata: PhiCaseStrata }),
	Schema.fieldsAssign({ canaries: Schema.NonEmptyArray(Canary) }),
	Schema.fieldsAssign({ canaryParts: Schema.optionalKey(CanaryParts) }),
	Schema.fieldsAssign({ fragments: Schema.Array(Fragment) }),
	Schema.fieldsAssign({ messages: Messages }),
);

type PhiStrata = (typeof PhiCase.Type)["strata"];

const CleanCase = pipe(
	Schema.Struct({ id: Schema.String }),
	Schema.fieldsAssign({ expect: Schema.Literal("clean") }),
	Schema.fieldsAssign({ strata: Schema.Struct({ negative: Negative }) }),
	Schema.fieldsAssign({ canaries: Schema.Tuple([]) }),
	Schema.fieldsAssign({ fragments: Schema.Array(Fragment) }),
	Schema.fieldsAssign({ messages: Messages }),
);

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
