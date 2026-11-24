import { Array, Effect, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import type { PieceKind } from "#router/features/policy/index.ts";
import { contentKey } from "#router/primitives/content-key.ts";
import { quoteMinChars } from "#router/features/policy/index.ts";
import { quotingReplies } from "./index.ts";

const record =
	'id,patient_id,driver_license,diagnosis\n76696,76696,U2546280,CANARY-DX\n  "value": "R600-434-88-750-1",';

const quotable = Effect.fnUntraced(function* quotable(name: string, kind: PieceKind, text: string) {
	return { key: yield* contentKey([name]), kind, texts: [text] };
});

const quoting = Effect.gen(function* quoting() {
	const sealedRecord = yield* quotable("record", "tool-result", record);
	const row = yield* quotable("row", "reply-other", "The failing row is\n```\n76696,76696,U2546280,CANARY-DX\n```");

	const inline = yield* quotable(
		"inline",
		"reply-other",
		'It fails on "value": "R600-434-88-750-1", which is too long.',
	);

	const found = quotingReplies({
		isSealed: (key) => key === sealedRecord.key,
		pieces: [sealedRecord, row, inline],
	});

	assert.deepStrictEqual(Array.fromIterable(found), [
		[row.key, sealedRecord.key],
		[inline.key, sealedRecord.key],
	]);
});

const notQuoting = Effect.gen(function* notQuoting() {
	const early = yield* quotable("early", "reply-other", "76696,76696,U2546280,CANARY-DX");
	const sealedRecord = yield* quotable("record", "tool-result", record);
	const short = yield* quotable("short", "reply-other", "Row 76696:\nCANARY-DX");
	const open = yield* quotable("open", "reply-open", "76696,76696,U2546280,CANARY-DX");
	const user = yield* quotable("user", "user", "76696,76696,U2546280,CANARY-DX");

	const found = quotingReplies({
		isSealed: (key) => key === sealedRecord.key,
		pieces: [early, sealedRecord, short, open, user],
	});

	assert.deepStrictEqual(Array.fromIterable(found), []);
});

const firstSource = Effect.gen(function* firstSource() {
	const sealedRecord = yield* quotable("record", "tool-result", record);
	const sealedRow = yield* quotable("sealed row", "user", "76696,76696,U2546280,CANARY-DX");
	const row = yield* quotable("row", "reply-other", "The failing row is 76696,76696,U2546280,CANARY-DX");
	const sealedKeys = new Set([sealedRecord.key, sealedRow.key]);

	const found = quotingReplies({
		isSealed: (key) => sealedKeys.has(key),
		pieces: [sealedRecord, sealedRow, row],
	});

	assert.deepStrictEqual(Array.fromIterable(found), [[row.key, sealedRecord.key]]);
});

it.layer(Digest.layerWebCrypto)("quotingReplies", (test) => {
	test.effect(
		"a BAA account's reply that repeats a line of sealed content, or quotes part of a long one, names that content",
		() => quoting,
	);

	test.effect(
		"a short shared line, an open-account reply, a user message and a reply before the sealed content do not count",
		() => notQuoting,
	);

	test.effect("a reply that repeats lines of two sealed pieces names the first of them", () => firstSource);
});

const shortestQuote = Effect.gen(function* shortestQuote() {
	const line = pipe("76696,U2546280,CANARY-DX", Str.takeLeft(quoteMinChars));
	const sealedRow = yield* quotable("row", "tool-result", `id,license,dx\n  ${line}  `);
	const reply = yield* quotable("reply", "reply-other", `Row:\n${line}`);

	const found = quotingReplies({
		isSealed: (key) => key === sealedRow.key,
		pieces: [sealedRow, reply],
	});

	assert.deepStrictEqual(Array.fromIterable(found), [[reply.key, sealedRow.key]]);
});

it.layer(Digest.layerWebCrypto)("quotingReplies at the shortest quote", (test) => {
	test.effect("a repeated line of exactly quoteMinChars characters, once trimmed, counts", () => shortestQuote);
});
