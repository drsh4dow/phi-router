import { Array, Effect, String as Str, Struct } from "effect";
import { Base64, Base64Url, Hex } from "effect/encoding";
import { Findings, Verdicts } from "./index.ts";
import { assert, it } from "@effect/vitest";
import { judgedOne, pieceOf } from "./scripted-judge.ts";
import { Digest } from "effect/crypto";
import type { Script } from "./scripted-judge.ts";

const mebibyte = 1_048_576;

const bombMebibytes = 5;

const bigMebibytes = 3;

const repeatedNotes = 200_000;

const overShortBytes = 65;

const keyBytes = 32;

const digestBytes = 64;

const gzipHeaderBytes = 12;

const byteStride = 37;

const byteOffset = 11;

const byteValues = 256;

const maxByte = 255;

const oneReading = 1;

const scoreZero = 0;

const clears: Script = { score: () => scoreZero };

const gzip = (text: string): Effect.Effect<Uint8Array> =>
	Effect.promise((): PromiseLike<Uint8Array> =>
		new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).bytes(),
	);

const gzipBase64 = (text: string): Effect.Effect<string> => Effect.map(gzip(text), (bytes) => Base64.encode(bytes));

const binary = (length: number): Uint8Array =>
	Uint8Array.from(Array.makeBy(length, (index) => (index * byteStride + byteOffset) % byteValues));

const sealed = (why: "binary" | "undecodable"): readonly unknown[] => [
	Verdicts.Sealed({ finding: Findings.Failure({ why }) }),
];

const judgedText = Effect.fnUntraced(function* judgedText(text: string) {
	const piece = yield* pieceOf(text);

	return yield* judgedOne({ piece, script: clears });
});

const note = "Patient Canary Fakesmith";

const base64Text = Effect.gen(function* base64Text() {
	const letter = `${note}\r\n\tseen for chest pain`;
	const encoded = Base64.encode(letter);
	const { fresh } = yield* judgedText(`token ${encoded}`);

	assert.deepStrictEqual(fresh, [`token ${encoded}\n${letter}`]);
});

const base64Words = Effect.gen(function* base64Words() {
	const { fresh } = yield* judgedText("emlwIHRlc3RpbmcgcGhvbmU=");

	assert.deepStrictEqual(fresh, ["emlwIHRlc3RpbmcgcGhvbmU=\nzip testing phone"]);
});

const base64UrlText = Effect.gen(function* base64UrlText() {
	const encoded = Base64Url.encode("Canary Fakesmith?? born 1900>>");
	const { fresh } = yield* judgedText(encoded);

	assert.deepStrictEqual(fresh, [`${encoded}\nCanary Fakesmith?? born 1900>>`]);
});

const gzipInBase64 = Effect.gen(function* gzipInBase64() {
	const encoded = yield* gzipBase64(note);
	const { fresh } = yield* judgedText(encoded);

	assert.deepStrictEqual(fresh, [`${encoded}\n${note}`]);
});

const gzipAsHex = Effect.gen(function* gzipAsHex() {
	const encoded = yield* Effect.map(gzip(note), (bytes) => Hex.encode(bytes));
	const { fresh } = yield* judgedText(`payload=${encoded}`);

	assert.deepStrictEqual(fresh, [`payload=${encoded}\n${note}`]);
});

const percentText = Effect.gen(function* percentText() {
	const { fresh } = yield* judgedText("GET /search?q=Canary+Fakesmith%2C%20chest%20pain 200");

	assert.deepStrictEqual(fresh, [
		"GET /search?q=Canary+Fakesmith%2C%20chest%20pain 200\n/search?q=Canary Fakesmith, chest pain",
	]);
});

const once = Base64.encode(note);

const twice = Base64.encode(once);

const thrice = Base64.encode(twice);

const threeLevels = Effect.gen(function* threeLevels() {
	const { fresh } = yield* judgedText(thrice);

	assert.deepStrictEqual(fresh, [`${thrice}\n${twice}\n${once}\n${note}`]);
});

const fourLevels = Effect.gen(function* fourLevels() {
	const { verdicts } = yield* judgedText(Base64.encode(thrice));

	assert.deepStrictEqual(verdicts, sealed("undecodable"));
});

const longBinary = Effect.gen(function* longBinary() {
	const { verdicts, fresh } = yield* judgedText(`blob ${Base64.encode(binary(overShortBytes))}`);

	assert.deepStrictEqual(verdicts, sealed("binary"));
	assert.deepStrictEqual(fresh, []);
});

const shortBinary = Effect.gen(function* shortBinary() {
	const key = `JWT_SECRET=${Base64.encode(binary(keyBytes))}`;
	const digest = `"digest": "${Base64.encode(binary(digestBytes))}"`;
	const { verdicts, fresh } = yield* judgedText(`${key}\n${digest}`);

	assert.deepStrictEqual(verdicts, [Verdicts.Cleared({ by: "judge" })]);
	assert.lengthOf(fresh, oneReading);
});

const corrupted = (bytes: Readonly<Uint8Array<Readonly<ArrayBufferLike>>>): Uint8Array =>
	Uint8Array.from(bytes, (byte, index) => {
		if (index > gzipHeaderBytes) {
			return maxByte - byte;
		}

		return byte;
	});

const corruptGzip = Effect.gen(function* corruptGzip() {
	const valid = yield* gzip(`${note}, seen for chest pain on 2024-01-05`);
	const { verdicts } = yield* judgedText(Base64.encode(corrupted(valid)));

	assert.deepStrictEqual(verdicts, sealed("undecodable"));
});

const gzipBomb = Effect.gen(function* gzipBomb() {
	const bomb = yield* gzipBase64(Str.repeat(bombMebibytes * mebibyte)("a"));
	const { verdicts } = yield* judgedText(bomb);

	assert.deepStrictEqual(verdicts, sealed("undecodable"));
});

const boundedAcrossTexts = Effect.gen(function* boundedAcrossTexts() {
	const big = yield* gzipBase64(Str.repeat(bigMebibytes * mebibyte)("a"));
	const piece = yield* pieceOf(big);
	const twoTexts = Struct.assign(piece, { texts: [big, big] });
	const { verdicts } = yield* judgedOne({ piece: twoTexts, script: clears });

	assert.deepStrictEqual(verdicts, sealed("undecodable"));
});

const boundedWithoutGzip = Effect.gen(function* boundedWithoutGzip() {
	const { verdicts } = yield* judgedText(Base64.encode(Str.repeat(repeatedNotes)(`${note}. `)));

	assert.deepStrictEqual(verdicts, sealed("undecodable"));
});

const lookAlikes = Array.join(
	[
		"commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
		"sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		"sha512 45843648ecf9da8e513286f136e3f271e7d6dee4d29b947a50dde8c61f3e197694c13bcdc279ce459839757cd8de19c11b23b33565384a97afcf360483578cd4",
		"id 550e8400-e29b-41d4-a716-446655440000",
		"bumped typescript 7.0.2 -> 7.0.3 in packages/phi-router",
		"see AbstractSingletonProxyFactoryBean for details",
		"open src/main/kotlin/com/acme/client2024v2/eligibility/models/CoverageEligibilityResponseMapper.kt",
		"fun test_returns_the_cached_value_when_the_key_was_written_in_2024Q1_and_has_not_expired_yet()",
		"cache miss for setup-bun-Linux-x64-node20-3f2a9c1e7b6d4f8a0c5e2b9d7a1f3c6e8b0d2f4a6c8e0b2d4f6a8c",
	],
	"\n",
);

const leftAsIs = Effect.gen(function* leftAsIs() {
	const { fresh } = yield* judgedText(lookAlikes);

	assert.deepStrictEqual(fresh, [lookAlikes]);
});

it.layer(Digest.layerWebCrypto)("expand reads encoded text", (test) => {
	test.effect("base64 text reaches the judge decoded, after the original", () => base64Text);
	test.effect(
		"base64 text whose encoding happens to read as words still reaches the judge decoded",
		() => base64Words,
	);
	test.effect("base64url text reaches the judge decoded", () => base64UrlText);
	test.effect("gzip inside base64 reaches the judge inflated", () => gzipInBase64);
	test.effect("gzip written as hex reaches the judge inflated", () => gzipAsHex);
	test.effect("percent-encoded text reaches the judge decoded", () => percentText);
	test.effect("a payload nested three levels deep is decoded at every level", () => threeLevels);
	test.effect("hex digests, UUIDs, versions, paths and identifiers are left as they are", () => leftAsIs);
});

it.layer(Digest.layerWebCrypto)("expand fails closed", (test) => {
	test.effect("a payload still encoded below three levels is undecodable", () => fourLevels);
	test.effect("decoded binary over 64 bytes seals as binary without a judge call", () => longBinary);
	test.effect(
		"decoded bytes of 64 or less, such as a key or a digest, never seal: the judge decides",
		() => shortBinary,
	);
	test.effect("a corrupt gzip seals as undecodable", () => corruptGzip);
	test.effect("a gzip that inflates past the size bound seals as undecodable", () => gzipBomb);
	test.effect("decoded output is bounded across all the texts of a piece", () => boundedAcrossTexts);
	test.effect("decoded output is bounded even when no payload is gzip", () => boundedWithoutGzip);
});
