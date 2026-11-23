import { Array, Effect } from "effect";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import type { PieceKind } from "#router/features/policy/index.ts";
import { contentKey } from "#router/primitives/content-key.ts";
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

it.layer(Digest.layerWebCrypto)("quotingReplies", (test) => {
	test.effect(
		"a BAA account's reply that repeats a line of sealed content, or quotes part of a long one, names that content",
		() => quoting,
	);

	test.effect(
		"a short shared line, an open-account reply, a user message and a reply before the sealed content do not count",
		() => notQuoting,
	);
});
