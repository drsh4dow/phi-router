import { Array, Effect, String as Str, pipe } from "effect";
import { Findings, Verdicts } from "./index.ts";
import { assert, it } from "@effect/vitest";
import { judgedOne, namedKind, pieceOf } from "./scripted-judge.ts";
import { Base64 } from "effect/encoding";
import { Digest } from "effect/crypto";
import type { Script } from "./scripted-judge.ts";

const firstUnit = 0;

const bytesPerUnit = 2;

const hexRadix = 16;

const hexDigits = 2;

const spaces = 25;

const scoreZero = 0;

const sealsHigh = 0.9;

const judged = Effect.fnUntraced(function* judged(text: string, script: Script) {
	const piece = yield* pieceOf(text);

	return yield* judgedOne({ piece, script });
});

const codePoints = (text: string): number[] =>
	pipe(Array.fromIterable(text), Array.map(Str.codePointAt(firstUnit)), Array.getSomes);

const utf16 = (text: string, littleEndian: boolean): Uint8Array => {
	const bytes = new Uint8Array(text.length * bytesPerUnit);
	const view = new DataView(bytes.buffer);

	for (const [index, unit] of codePoints(text).entries()) {
		view.setUint16(index * bytesPerUnit, unit, littleEndian);
	}

	return bytes;
};

const latin1 = (text: string): Uint8Array => Uint8Array.from(codePoints(text));

const shortTexts: readonly (readonly [encoding: string, text: string, bytes: Uint8Array])[] = [
	["UTF-16LE", "Canary Fakesmith has HIV", utf16("Canary Fakesmith has HIV", true)],
	["UTF-16BE", "Canary Fakesmith has HIV", utf16("Canary Fakesmith has HIV", false)],
	["UTF-16LE", "Канарейка Фейк, ВИЧ", utf16("Канарейка Фейк, ВИЧ", true)],
	["Latin-1", "Señora Fálsa tiene VIH", latin1("Señora Fálsa tiene VIH")],
];

const longUtf16 = Effect.gen(function* longUtf16() {
	const text = "Discharge note: Canary Fakesmith, admitted with pneumonia, discharged on day four.";
	const encoded = Base64.encode(utf16(text, true));
	const { verdicts, fresh } = yield* judged(`blob ${encoded}`, { score: () => scoreZero });

	assert.deepStrictEqual(verdicts, [Verdicts.Cleared({ by: "judge" })]);
	assert.include(Array.join(fresh, ""), text);
});

const percentEncoded = (bytes: Readonly<Uint8Array<Readonly<ArrayBufferLike>>>): string =>
	pipe(
		Array.fromIterable(bytes),
		Array.map((byte) => `%${Str.padStart(hexDigits, "0")(byte.toString(hexRadix))}`),
		Array.join(""),
	);

/**
 * Seals only on the plain note, so a piece seals exactly when the judge was shown a correct reading.
 *
 * @param {string} plain The note as written.
 * @returns {Script} The script.
 */
const seesNote = (plain: string): Script => ({
	kind: () => namedKind,
	score: ({ piece }) => {
		if (Str.includes(plain)(piece)) {
			return sealsHigh;
		}

		return scoreZero;
	},
});

const asWritten: readonly (readonly [label: string, plain: string, bytes: Uint8Array])[] = [
	["short mixed-script UTF-16LE", "Ψευδ HIV", utf16("Ψευδ HIV", true)],
	["NUL-terminated UTF-16LE", "Canary Fakesmith has HIV", utf16("Canary Fakesmith has HIV\0", true)],
	["accented Latin-1", "Fáké HIV.", latin1("Fáké HIV.")],
	["66-byte mixed-script UTF-16LE", "Фейк HIV", utf16(`Фейк HIV${Str.repeat(spaces)(" ")}`, true)],
	[
		"long UTF-16LE whose private-use glyph leaves only the byte-swapped reading text-like:",
		"Фейк HIV",
		utf16(`Фейк HIV${Str.repeat(spaces)(" ")}\uE0A0`, true),
	],
];

it.layer(Digest.layerWebCrypto)("legacy encodings", (test) => {
	test.effect.each(shortTexts)("short %s text reaches the judge decoded: %s", ([, text, bytes]) =>
		Effect.gen(function* shortText() {
			const { verdicts, fresh } = yield* judged(`blob ${Base64.encode(bytes)}`, { score: () => scoreZero });

			assert.deepStrictEqual(verdicts, [Verdicts.Cleared({ by: "judge" })]);
			assert.include(Array.join(fresh, ""), text);
		}),
	);

	test.effect("long UTF-16LE text is judged, not sealed as binary", () => longUtf16);

	test.effect.each(asWritten)("%s text reaches the judge as written: %s", ([, plain, bytes]) =>
		Effect.gen(function* writtenText() {
			const { verdicts } = yield* judged(`q=${percentEncoded(bytes)}`, seesNote(plain));

			assert.deepStrictEqual(verdicts, [
				Verdicts.Sealed({ finding: Findings.Judge({ kind: namedKind, score: sealsHigh }) }),
			]);
		}),
	);
});
