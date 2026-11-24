import { Array, Function, Number as Num, Predicate, Record, pipe } from "effect";

const binary = 2;

const bitsPerByte = 8;

const bitsPerWord = 32;

const byteValues = binary ** bitsPerByte;

const wordValues = binary ** bitsPerWord;

const wordBytes = bitsPerWord / bitsPerByte;

const dataFirstArity = 2;

const digitAt = (value: number, place: number, base: number): number => Math.floor(value / place) % base;

/** The value of each bit of a byte, lowest first. */
const bitPlaces = Array.makeBy(bitsPerByte, (bit) => binary ** bit);

/** The value of each byte of an unsigned 32-bit integer, lowest first. */
const bytePlaces = Array.makeBy(wordBytes, (byte) => byteValues ** byte);

/** `left ^ right` for every pair of bytes, at `left * byteValues + right`, so a 32-bit xor takes four lookups. */
const byteXors = Array.makeBy(byteValues * byteValues, (pair) =>
	pipe(
		bitPlaces,
		Array.map((place) => {
			const left = digitAt(Math.floor(pair / byteValues), place, binary);

			return Math.abs(left - digitAt(pair % byteValues, place, binary)) * place;
		}),
		Num.sumAll,
	),
);

/** `value >>> count` for a non-negative integer. */
const shiftRight: {
	(count: number): (value: number) => number;
	(value: number, count: number): number;
} = Function.dual(dataFirstArity, (value: number, count: number): number => Math.floor(value / binary ** count));

/**
 * `value >>> 0`: the integer as an unsigned 32-bit integer.
 *
 * @param {number} value Any integer.
 * @returns {number} Its low 32 bits, unsigned.
 */
const unsigned32 = (value: number): number => ((value % wordValues) + wordValues) % wordValues;

/** `left ^ right` for unsigned 32-bit integers, in arithmetic. */
const xor: {
	(right: number): (left: number) => number;
	(left: number, right: number): number;
} = Function.dual(dataFirstArity, (left: number, right: number): number => {
	let result = 0;

	for (const place of bytePlaces) {
		const pair = digitAt(left, place, byteValues) * byteValues + digitAt(right, place, byteValues);

		result += Array.getUnsafe(byteXors, pair) * place;
	}

	return result;
});

/** `left | right` for unsigned 32-bit integers: each bit set in either is set once. */
const or: {
	(right: number): (left: number) => number;
	(left: number, right: number): number;
} = Function.dual(dataFirstArity, (left: number, right: number): number => (left + right + xor(left, right)) / binary);

/** CRC-32's polynomial, bit-reversed, as gzip uses it. */
const crcPolynomial = 3_988_292_384;

const allOnes = 4_294_967_295;

const crcStep = (crc: number): number => {
	const shifted = Math.floor(crc / binary);

	if (Number.isInteger(crc / binary)) {
		return shifted;
	}

	return xor(crcPolynomial, shifted);
};

const crcTable = Array.makeBy(byteValues, (index) => {
	let crc = index;

	for (const step of Array.replicate(crcStep, bitsPerByte)) {
		crc = step(crc);
	}

	return crc;
});

const crc32 = (bytes: readonly number[]): number => {
	let crc = allOnes;

	for (const byte of bytes) {
		crc = xor(Array.getUnsafe(crcTable, xor(crc, byte) % byteValues), shiftRight(crc, bitsPerByte));
	}

	return xor(crc, allOnes);
};

const littleEndian32 = (value: number): number[] =>
	Array.makeBy(wordBytes, (index) => shiftRight(value, index * bitsPerByte) % byteValues);

/**
 * A value's bits, least significant first, the order deflate packs header fields in.
 *
 * @param {number} value The value.
 * @param {number} length How many bits it takes.
 * @returns {number[]} Its bits.
 */
const bitsLowFirst = (value: number, length: number): number[] =>
	Array.makeBy(length, (bit) => shiftRight(value, bit) % binary);

/**
 * A Huffman code's bits, most significant first, the order deflate packs them in.
 *
 * @param {number} code The code.
 * @param {number} length How many bits it takes.
 * @returns {number[]} Its bits.
 */
const codeBits = (code: number, length: number): number[] => Array.reverse(bitsLowFirst(code, length));

/** RFC 1951's fixed literal codes: a literal below `nineBitLiterals.first` takes an 8-bit code, the rest 9 bits. */
const eightBitLiterals = { bits: 8, code: 48 } as const;

const nineBitLiterals = { bits: 9, code: 400, first: 144 } as const;

/** The 7-bit code 256 that ends a block. */
const endOfBlock = { bits: 7, code: 0 } as const;

/** A block header as one 3-bit field: BFINAL 1, the last block, and BTYPE 01, the fixed Huffman code. */
const finalFixedBlock = { bits: 3, value: 3 } as const;

const literalBits = (byte: number): number[] => {
	if (byte < nineBitLiterals.first) {
		return codeBits(eightBitLiterals.code + byte, eightBitLiterals.bits);
	}

	return codeBits(nineBitLiterals.code + byte - nineBitLiterals.first, nineBitLiterals.bits);
};

/**
 * One final deflate block with the fixed Huffman code and literals only (RFC 1951, 3.2.6).
 *
 * @param {readonly number[]} bytes The bytes to compress.
 * @returns {number[]} The block's bytes.
 */
const deflateFixed = (bytes: readonly number[]): number[] => {
	const bits = [
		...bitsLowFirst(finalFixedBlock.value, finalFixedBlock.bits),
		...pipe(
			bytes,
			Array.flatMap((byte) => literalBits(byte)),
		),
		...codeBits(endOfBlock.code, endOfBlock.bits),
	];

	return pipe(
		Array.chunksOf(bits, bitsPerByte),
		Array.map((octet) =>
			pipe(
				octet,
				Array.map((bit, index) => bit * binary ** index),
				Num.sumAll,
			),
		),
	);
};

const gzipHeader = { deflate: 8, extraFlags: 0, flags: 0, id1: 31, id2: 139, mtime: 0, unix: 3 } as const;

/**
 * A complete gzip member (RFC 1952) with a zero mtime, so the same text always gives the same bytes.
 *
 * @param {string} text The text to compress.
 * @returns {Uint8Array} The member's bytes.
 */
const gzip = (text: string): Uint8Array => {
	const bytes = Array.fromIterable(new TextEncoder().encode(text));

	return Uint8Array.from([
		gzipHeader.id1,
		gzipHeader.id2,
		gzipHeader.deflate,
		gzipHeader.flags,
		...littleEndian32(gzipHeader.mtime),
		gzipHeader.extraFlags,
		gzipHeader.unix,
		...deflateFixed(bytes),
		...littleEndian32(crc32(bytes)),
		...littleEndian32(bytes.length),
	]);
};

type Json = string | number | boolean | null | readonly Json[] | JsonObject;

interface JsonObject {
	readonly [key: string]: Json;
}

const escapes = new Map([
	['"', String.raw`\"`],
	["\\", String.raw`\\`],
	["\n", String.raw`\n`],
	["\r", String.raw`\r`],
	["\t", String.raw`\t`],
]);

const jsonString = (text: string): string => {
	const escaped = pipe(
		Array.fromIterable(text),
		Array.map((char) => escapes.get(char) ?? char),
	);

	return `"${Array.join(escaped, "")}"`;
};

const isList = (node: Json): node is readonly Json[] => Array.isArray(node);

/** How a writer lays JSON out: the indent per level, and what opens each line of a nested value at a given depth. */
interface Layout {
	readonly colon: string;
	readonly indent: string;
	readonly lineAt: (depth: string) => string;
}

const writeJson = (layout: Layout): ((value: Json) => string) => {
	const bracketed = (brackets: readonly [string, string], items: readonly string[], depth: string): string => {
		const [open, close] = brackets;

		if (Array.isReadonlyArrayNonEmpty(items)) {
			const inner = layout.lineAt(depth + layout.indent);

			return `${open}${inner}${Array.join(items, `,${inner}`)}${layout.lineAt(depth)}${close}`;
		}

		return `${open}${close}`;
	};

	const write = (node: Json, depth: string): string => {
		if (Predicate.isString(node)) {
			return jsonString(node);
		}

		if (Predicate.isNull(node) || Predicate.isNumber(node) || Predicate.isBoolean(node)) {
			return String(node);
		}

		const deeper = depth + layout.indent;

		if (isList(node)) {
			const items = pipe(
				node,
				Array.map((item) => write(item, deeper)),
			);

			return bracketed(["[", "]"], items, depth);
		}

		const members = pipe(
			Record.toEntries(node),
			Array.map(([key, item]) => `${jsonString(key)}${layout.colon}${write(item, deeper)}`),
		);

		return bracketed(["{", "}"], members, depth);
	};

	return (value) => write(value, "");
};

const compactJson = writeJson({ colon: ":", indent: "", lineAt: () => "" });

const prettyJson = writeJson({ colon: ": ", indent: "  ", lineAt: (depth) => `\n${depth}` });

export { compactJson, gzip, or, prettyJson, shiftRight, unsigned32, xor };

export type { JsonObject };
