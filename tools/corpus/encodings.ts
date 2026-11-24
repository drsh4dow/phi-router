import { Array, Function, Number as Num, Predicate, Record, pipe } from "effect";

const binary = 2;

const bitsPerByte = 8;

const bitsPerWord = 32;

const byteValues = binary ** bitsPerByte;

const wordValues = binary ** bitsPerWord;

const wordBytes = bitsPerWord / bitsPerByte;

const dataFirstArity = 2;

const digitAt = (value: number, place: number, base: number): number => Math.floor(value / place) % base;

const bitWeightsLowFirst = Array.makeBy(bitsPerByte, (bit) => binary ** bit);

const byteWeightsLowFirst = Array.makeBy(wordBytes, (byte) => byteValues ** byte);

const byteXors = Array.makeBy(byteValues * byteValues, (pair) =>
	pipe(
		bitWeightsLowFirst,
		Array.map((place) => {
			const left = digitAt(Math.floor(pair / byteValues), place, binary);

			return Math.abs(left - digitAt(pair % byteValues, place, binary)) * place;
		}),
		Num.sumAll,
	),
);

const shiftRight: {
	(count: number): (value: number) => number;
	(value: number, count: number): number;
} = Function.dual(dataFirstArity, (value: number, count: number): number => Math.floor(value / binary ** count));

const unsigned32 = (value: number): number => ((value % wordValues) + wordValues) % wordValues;

const xor: {
	(right: number): (left: number) => number;
	(left: number, right: number): number;
} = Function.dual(dataFirstArity, (left: number, right: number): number => {
	let result = 0;

	for (const place of byteWeightsLowFirst) {
		const pair = digitAt(left, place, byteValues) * byteValues + digitAt(right, place, byteValues);

		result += Array.getUnsafe(byteXors, pair) * place;
	}

	return result;
});

const or: {
	(right: number): (left: number) => number;
	(left: number, right: number): number;
} = Function.dual(dataFirstArity, (left: number, right: number): number => (left + right + xor(left, right)) / binary);

const reversedCrc32Polynomial = 3_988_292_384;

const allOnes = 4_294_967_295;

const crcStep = (crc: number): number => {
	const shifted = Math.floor(crc / binary);

	if (Number.isInteger(crc / binary)) {
		return shifted;
	}

	return xor(reversedCrc32Polynomial, shifted);
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

const bitsLowFirst = (value: number, length: number): number[] =>
	Array.makeBy(length, (bit) => shiftRight(value, bit) % binary);

const codeBits = (code: number, length: number): number[] => Array.reverse(bitsLowFirst(code, length));

const eightBitLiterals = { bits: 8, code: 48 } as const;

const nineBitLiterals = { bits: 9, code: 400, first: 144 } as const;

const endOfBlock = { bits: 7, code: 0 } as const;

const finalFixedBlock = { bits: 3, value: 3 } as const;

const literalBits = (byte: number): number[] => {
	if (byte < nineBitLiterals.first) {
		return codeBits(eightBitLiterals.code + byte, eightBitLiterals.bits);
	}

	return codeBits(nineBitLiterals.code + byte - nineBitLiterals.first, nineBitLiterals.bits);
};

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

interface JsonLayout {
	readonly colon: string;
	readonly indent: string;
	readonly lineStartAt: (indentation: string) => string;
}

const writeJson = (layout: JsonLayout): ((value: Json) => string) => {
	const bracketed = (brackets: readonly [string, string], items: readonly string[], indentation: string): string => {
		const [open, close] = brackets;

		if (Array.isReadonlyArrayNonEmpty(items)) {
			const inner = layout.lineStartAt(indentation + layout.indent);

			return `${open}${inner}${Array.join(items, `,${inner}`)}${layout.lineStartAt(indentation)}${close}`;
		}

		return `${open}${close}`;
	};

	const write = (node: Json, indentation: string): string => {
		if (Predicate.isString(node)) {
			return jsonString(node);
		}

		if (Predicate.isNull(node) || Predicate.isNumber(node) || Predicate.isBoolean(node)) {
			return String(node);
		}

		const deeper = indentation + layout.indent;

		if (isList(node)) {
			const items = pipe(
				node,
				Array.map((item) => write(item, deeper)),
			);

			return bracketed(["[", "]"], items, indentation);
		}

		const members = pipe(
			Record.toEntries(node),
			Array.map(([key, item]) => `${jsonString(key)}${layout.colon}${write(item, deeper)}`),
		);

		return bracketed(["{", "}"], members, indentation);
	};

	return (value) => write(value, "");
};

const compactJson = writeJson({ colon: ":", indent: "", lineStartAt: () => "" });

const prettyJson = writeJson({ colon: ": ", indent: "  ", lineStartAt: (indentation) => `\n${indentation}` });

export { compactJson, gzip, or, prettyJson, shiftRight, unsigned32, xor };

export type { JsonObject };
