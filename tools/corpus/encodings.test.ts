import { Array, Effect, pipe } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { gzip, or, shiftRight, unsigned32, xor } from "./encodings.ts";

const wordPairs = [
	{ left: 0, or: 0, right: 0, xor: 0 },
	{ left: 4_042_322_160, or: 4_293_984_240, right: 4_278_255_360, xor: 267_390_960 },
	{ left: 4_294_967_295, or: 4_294_967_295, right: 2_147_483_649, xor: 2_147_483_646 },
	{ left: 305_419_896, or: 524_246_911, right: 252_645_135, xor: 490_428_791 },
	{ left: 3_735_928_559, or: 3_752_853_487, right: 19_088_743, xor: 3_750_689_672 },
] as const;

const shifts = [
	{ count: 0, shifted: 2_147_483_648, value: 2_147_483_648 },
	{ count: 4, shifted: 233_495_534, value: 3_735_928_559 },
	{ count: 31, shifted: 1, value: 4_294_967_295 },
	{ count: 3, shifted: 0, value: 5 },
] as const;

const wraps = [
	{ unsigned: 4_294_967_295, value: -1 },
	{ unsigned: 7, value: 4_294_967_303 },
	{ unsigned: 0, value: -4_294_967_296 },
	{ unsigned: 2_147_483_648, value: -2_147_483_648 },
	{ unsigned: 3, value: 1_099_511_627_779 },
	{ unsigned: 2_147_483_647, value: 2_147_483_647 },
] as const;

const texts = [
	"",
	"MRN 4417-2290 fails the importer.",
	"Straße 12, 80331 München",
	"12 đường Nguyễn Văn Linh",
	"東京都 🙂",
];

const gzipRoundTrip = (text: string): Effect.Effect<string> => {
	const gunzipped = new Blob([Uint8Array.from(gzip(text))]).stream().pipeThrough(new DecompressionStream("gzip"));

	return Effect.promise((): PromiseLike<string> => new Response(gunzipped).text());
};

const bitwise = Effect.sync(() => {
	assert.deepStrictEqual(
		pipe(
			wordPairs,
			Array.map(({ left, right }) => ({ or: or(left, right), xor: xor(left, right) })),
		),
		pipe(
			wordPairs,
			Array.map((pair) => ({ or: pair.or, xor: pair.xor })),
		),
	);
	assert.deepStrictEqual(
		pipe(
			shifts,
			Array.map(({ value, count }) => shiftRight(value, count)),
		),
		pipe(
			shifts,
			Array.map(({ shifted }) => shifted),
		),
	);
	assert.deepStrictEqual(
		pipe(
			wraps,
			Array.map(({ value }) => unsigned32(value)),
		),
		pipe(
			wraps,
			Array.map(({ unsigned }) => unsigned),
		),
	);
});

const roundTrip = Effect.gen(function* roundTrip() {
	const gunzipped = yield* Effect.forEach(texts, gzipRoundTrip, { concurrency: 1 });

	assert.deepStrictEqual(gunzipped, texts);
});

describe("encodings", () => {
	it.effect(
		"xor, or, shiftRight and unsigned32 give what JavaScript's ^, |, >>> and >>> 0 give on 32-bit integers",
		() => bitwise,
	);
	it.effect("gzip gives a member that gunzips back to its text, whatever bytes the text encodes to", () => roundTrip);
});
