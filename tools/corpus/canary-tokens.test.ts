import { Array, Effect, Schema, String as Str, Struct, pipe } from "effect";
import { Base64, Hex } from "effect/encoding";
import type { Case, Message, PhiCase } from "./manifest.ts";
import { assert, describe, it } from "@effect/vitest";
import { failed } from "./wire-table.ts";
import { foundIn } from "./request-bodies.ts";
import { gzip } from "./encodings.ts";
import { identifierKind } from "#router/features/policy/index.ts";
import { seenOn } from "./seen.ts";
import { tokensOf } from "./canary-tokens.ts";

const mrn = "MRN 4417-2290";

const record = `{"patient":"Synthetic Person","mrn":"${mrn}","diagnosis":"E11.9"}`;

const pixel = { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ", mimeType: "image/png" };

/** The one message that held the canary, seen as one distinctive piece. */
const oneMessage = 1;

/** One part of a split canary. */
const onePart = 1;

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const phiCase = (entry: "user" | "tool-result", messages: readonly [Message, ...Message[]]): typeof PhiCase.Type => ({
	canaries: [mrn],
	expect: "phi",
	fragments: [],
	id: "t-1",
	messages,
	strata: { carrier: "fhir-json", entry, identifier: identifierKind.medicalRecordNumber, transform: "plain" },
});

const bodiesOf = (texts: readonly string[]): Effect.Effect<string[], Schema.SchemaError> =>
	Effect.forEach(texts, (content) => encodeJson({ messages: [{ content }] }), { concurrency: 1 });

const seen = Effect.fnUntraced(function* seen(
	subject: Case,
	sent: { readonly open: readonly string[]; readonly baa: readonly string[] },
) {
	const tracked = yield* tokensOf(subject);
	const open = yield* bodiesOf(sent.open);
	const baa = yield* bodiesOf(sent.baa);

	return seenOn({ baa, open, tracked });
});

const textsOf = (subject: Case): string[] =>
	pipe(
		subject.messages,
		Array.flatMap((message) => {
			if ("text" in message) {
				return [message.text];
			}

			return [];
		}),
	);

const nothing = { fragments: [], leaked: [], missing: [], split: [], unsealed: [] };

const completeLeak = Effect.gen(function* completeLeak() {
	const ask = "Can you check why the importer rejects the row below?";

	const subject = phiCase("user", [
		{ role: "user", text: ask },
		{ role: "user", text: `${ask}\n${record}` },
	]);

	const onBaa = yield* seen(subject, { baa: textsOf(subject), open: [ask] });
	const onOpen = yield* seen(subject, { baa: textsOf(subject), open: textsOf(subject) });

	assert.deepStrictEqual(onBaa, nothing);
	assert.deepStrictEqual(onOpen.leaked, [mrn]);
	assert.lengthOf(onOpen.unsealed, oneMessage);
});

const redactedLeak = Effect.gen(function* redactedLeak() {
	const text = `${record} fails the importer.`;
	const subject = phiCase("user", [{ role: "user", text }]);

	const result = yield* seen(subject, { baa: [text], open: [Str.replace(mrn, "[redacted]")(text)] });

	assert.deepStrictEqual(result.leaked, []);
	assert.lengthOf(result.unsealed, oneMessage);
	assert.isTrue(failed(result));
});

const encodedLeak = Effect.gen(function* encodedLeak() {
	const base64 = Base64.encode(record);
	const hex = Hex.encode(gzip(record));
	const encoded = phiCase("tool-result", [{ role: "tool", text: `payload: ${base64}\n(1 row)` }]);
	const zipped = phiCase("tool-result", [{ role: "tool", text: ` 29637 | gzip | \\x${hex}\n(1 row)` }]);

	const fromBase64 = yield* seen(encoded, { baa: textsOf(encoded), open: [base64] });
	const fromHex = yield* seen(zipped, { baa: textsOf(zipped), open: [hex] });

	assert.deepStrictEqual(fromBase64.leaked, [base64]);
	assert.deepStrictEqual(fromHex.leaked, [hex]);
});

const dumpRows = 3000;

const rowsBeforeRecord = 2000;

const pageRows = 100;

const inventoryRow = (at: number): string =>
	`INSERT INTO public.inventory VALUES ('SKU-${String(at)}', ${String(at)});`;

const pagedOutput = Effect.gen(function* pagedOutput() {
	const rows = Array.makeBy(dumpRows, inventoryRow);

	const dump = Array.join(
		[...Array.take(rows, rowsBeforeRecord), record, ...Array.drop(rows, rowsBeforeRecord)],
		"\n",
	);

	const subject = phiCase("tool-result", [{ role: "tool", text: dump }]);

	const firstPage = yield* seen(subject, { baa: [dump], open: [Array.join(Array.take(rows, pageRows), "\n")] });
	const redacted = yield* seen(subject, { baa: [dump], open: [Str.replace(mrn, "[redacted]")(dump)] });

	assert.deepStrictEqual(firstPage, nothing);
	assert.lengthOf(redacted.unsealed, oneMessage);
});

const paddingChars = 60;

const cut = { first: `${Str.repeat(paddingChars)("a")}MRN 4417-`, second: `2290${Str.repeat(paddingChars)("b")}` };

const splitCase: Case = Struct.assign(
	phiCase("user", [
		{ role: "user", text: cut.first },
		{ role: "user", text: cut.second },
	]),
	{ canaryParts: { [mrn]: ["MRN 4417-", "2290"] as const } },
);

type ToolResult = Readonly<{ content: string; tool_use_id: string; type: "tool_result" }>;

type Turn = Readonly<{ messages: readonly Readonly<{ content: readonly ToolResult[]; role: "user" }>[] }>;

const resultOf = (content: string): ToolResult => ({ content, tool_use_id: "t", type: "tool_result" });

const turnOf = (content: readonly ToolResult[]): Turn => ({ messages: [{ content, role: "user" }] });

/**
 * One request body that carries each text as its own message.
 *
 * @param {readonly string[]} texts The texts, one per message.
 * @returns {Effect.Effect} The body.
 */
const bodyOf = (texts: readonly string[]): Effect.Effect<string, Schema.SchemaError> =>
	encodeJson({
		messages: pipe(
			texts,
			Array.map((content) => ({ content, role: "user" })),
		),
	});

const splitApart = Effect.gen(function* splitApart() {
	const tracked = yield* tokensOf(splitCase);
	const apart = [yield* bodyOf([cut.first]), yield* bodyOf([cut.second])];
	const together = [yield* bodyOf([cut.first, cut.second])];

	const twoRequests = seenOn({ baa: together, open: apart, tracked });
	const oneRequest = seenOn({ baa: [], open: together, tracked });

	assert.deepStrictEqual([twoRequests.leaked, twoRequests.split], [[], [mrn]]);
	assert.deepStrictEqual([oneRequest.leaked, oneRequest.split, oneRequest.missing], [[], [mrn], []]);
	assert.isFalse(failed(oneRequest));
});

const splitHalf = Effect.gen(function* splitHalf() {
	const tracked = yield* tokensOf(splitCase);
	const first = yield* bodyOf([cut.first]);
	const second = yield* bodyOf([cut.second]);
	const halfOnBaa = seenOn({ baa: [second], open: [first], tracked });

	assert.deepStrictEqual([halfOnBaa.leaked, halfOnBaa.split, halfOnBaa.fragments.length], [[], [], onePart]);
	assert.isFalse(failed(halfOnBaa));
});

const splitRejoined = Effect.gen(function* splitRejoined() {
	const tracked = yield* tokensOf(splitCase);
	const baa = [yield* bodyOf([cut.first, cut.second])];

	const rejoined = seenOn({ baa, open: [yield* bodyOf([`The id is ${mrn}.`])], tracked });
	const pasted = seenOn({ baa, open: [yield* bodyOf([`${cut.first}\n${cut.second}`])], tracked });

	assert.deepStrictEqual([rejoined.leaked, rejoined.split], [[mrn], []]);
	assert.deepStrictEqual([pasted.leaked, pasted.split], [[mrn], []]);
	assert.isTrue(failed(rejoined));
});

const anthropicTurns = Effect.gen(function* anthropicTurns() {
	const tracked = yield* tokensOf(splitCase);
	const baa = [yield* bodyOf([cut.first, cut.second])];

	const results = yield* encodeJson(turnOf([resultOf(cut.first), resultOf(cut.second)]));
	const inOneResult = yield* encodeJson(turnOf([resultOf(`${cut.first}${cut.second}`)]));
	const fromSystem = yield* encodeJson({ messages: [{ content: cut.second, role: "user" }], system: cut.first });

	assert.deepStrictEqual(seenOn({ baa, open: [results], tracked }).split, [mrn]);
	assert.deepStrictEqual(seenOn({ baa, open: [fromSystem], tracked }).split, [mrn]);
	assert.deepStrictEqual(seenOn({ baa, open: [inOneResult], tracked }).leaked, [mrn]);
});

const fragmentShown = Effect.gen(function* fragmentShown() {
	const subject: Case = {
		canaries: [],
		expect: "clean",
		fragments: ["Wexford"],
		id: "c-1",
		messages: [{ role: "user", text: "The lookup failed for the surname Wexford." }],
		strata: { negative: "fragment" },
	};

	const result = yield* seen(subject, { baa: [], open: textsOf(subject) });

	assert.deepStrictEqual(result, Struct.assign(nothing, { fragments: ["Wexford"] }));
	assert.isFalse(failed(result));
});

const canaryStart = 4;

const canaryEnd = 28;

const imageLeak = Effect.gen(function* imageLeak() {
	const canary = Str.slice(canaryStart, canaryEnd)(pixel.data);

	const subject: Case = Struct.assign(phiCase("user", [{ image: pixel, role: "user" }]), {
		canaries: [canary] as const,
	});

	const onBaa = yield* seen(subject, { baa: [pixel.data], open: [] });
	const onOpen = yield* seen(subject, { baa: [pixel.data], open: [pixel.data] });

	assert.deepStrictEqual(onBaa, nothing);
	assert.deepStrictEqual(onOpen.leaked, [canary]);
});

const missing = Effect.gen(function* missing() {
	const subject = phiCase("user", [{ role: "user", text: `The row is ${record}` }]);
	const absent = phiCase("user", [{ role: "user", text: "Nothing to see." }]);

	const undelivered = yield* seen(subject, { baa: [], open: [] });
	const untracked = yield* seen(absent, { baa: [], open: [] });

	assert.include(undelivered.missing, mrn);
	assert.deepStrictEqual(untracked.missing, [mrn]);
});

const escapedToken = Effect.gen(function* escapedToken() {
	const token = "line one\nline two";
	const body = yield* encodeJson({ messages: [{ content: `x ${token} y` }] });

	assert.deepStrictEqual(foundIn({ bodies: [body], tokens: [token, "line three"] }), [token]);
});

describe("canary tokens", () => {
	it.effect(
		"a complete canary in an open account's body is a leak, and the message that held it is unsealed",
		() => completeLeak,
	);
	it.effect(
		"a sealed message with its identifier redacted still shows on an open account's body, as unsealed and not leaked",
		() => redactedLeak,
	);
	it.effect("a canary carried in base64 or gzip hex leaks as the encoded run", () => encodedLeak);
	it.effect(
		"a tool output the harness reads in pages is sealed page by page, so a page without the identifier may go to an open account",
		() => pagedOutput,
	);
	it.effect("a fragment on an open account's body is counted", () => fragmentShown);
	it.effect(
		"an image canary is a run of its base64 data, and leaks when the image reaches an open account's body",
		() => imageLeak,
	);
	it.effect("PHI no BAA account's body carried, or a canary no message carries, is missing", () => missing);
	it.effect("a token with a line break is found in a JSON body, where it is escaped", () => escapedToken);
});

describe("split canaries", () => {
	it.effect(
		"a split canary whose parts reached open accounts in different messages is reported as split",
		() => splitApart,
	);
	it.effect("one part of a split canary on an open account's body is a fragment", () => splitHalf);
	it.effect(
		"a split canary that one open-account message held whole, or with every part, is a leak",
		() => splitRejoined,
	);
	it.effect(
		"each tool result of an Anthropic turn is its own message, and the system prompt is another",
		() => anthropicTurns,
	);
});
