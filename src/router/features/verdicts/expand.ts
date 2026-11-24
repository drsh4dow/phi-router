import { Array, Effect, Number as Num, Option, Result, String as Str, pipe } from "effect";
import { Base64Url, Hex } from "effect/encoding";

type Unexpandable = "binary" | "undecodable";

type Bytes = Readonly<Uint8Array<Readonly<ArrayBufferLike>>>;

type Chunk = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

type Read = () => PromiseLike<Chunk>;

const maxDepth = 3;

const maxDecodedBytes = 4_194_304;

const shortBytes = 64;

const sentLevel = 0;

const hexRadix = 16;

const gzipMagic = { first: 31, second: 139 } as const;

const byteValues = { carriageReturn: 13, del: 127, lineFeed: 10, pastC0: 32, tab: 9 } as const;

const base64Run = /[\w+/-]{16,}={0,2}/gu;

/** Hex gzip: the magic `1f 8b`, deflate (`08`), and at least the 20 bytes of an empty member. */
const gzipHex = /(?<![\da-f])1f8b08(?:[\da-f]{2}){17,}(?![\da-f])/giu;

const percentRun = /(?<![!-~])[!-$&-~]*(?:%[\dA-Fa-f]{2}[!-$&-~]*)+/gu;

const looksBase64 = (run: string): boolean =>
	/[A-Z]/u.test(run) && /[a-z]/u.test(run) && /\d/u.test(run) && !(/[+/]/u.test(run) && /[-_]/u.test(run));

const wordLike = /(?<![^+/_-])[\da-z]+(?![^+/_-])|[a-z]{4,}/gu;

const readsAsWords = (run: string): boolean => {
	const wordChars = pipe(
		[...Str.matchAll(wordLike)(run)],
		Array.map(([word]) => word.length),
		Num.sumAll,
	);

	return wordChars > run.length - wordChars;
};

const concat = (chunks: readonly Bytes[]): Uint8Array => {
	const joined = new Uint8Array(
		pipe(
			chunks,
			Array.map((chunk) => chunk.length),
			Num.sumAll,
		),
	);

	let offset = 0;

	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.length;
	}

	return joined;
};

const fromBase64 = (run: string): Option.Option<Uint8Array> => {
	const urlAlphabet = Str.replaceAll("/", "_")(Str.replaceAll("+", "-")(run));

	return Result.getSuccess(Base64Url.decode(urlAlphabet));
};

const encoder = new TextEncoder();

const percentPiece = /%(?<escaped>[\dA-Fa-f]{2})|[^%]+/gu;

const fromPercent = (run: string): Uint8Array =>
	concat(
		pipe(
			[...Str.matchAll(percentPiece)(run)],
			Array.map(([text, escaped]) =>
				Option.match(Option.fromUndefinedOr(escaped), {
					onNone: () => encoder.encode(Str.replaceAll("+", " ")(text)),
					onSome: (hex) => Uint8Array.of(Number.parseInt(hex, hexRadix)),
				}),
			),
		),
	);

const isGzip = (bytes: Bytes): boolean => {
	const [first, second] = bytes;

	return first === gzipMagic.first && second === gzipMagic.second;
};

const undecodable = Effect.fail<Unexpandable>("undecodable");

const gunzip = (gzip: Bytes): ReadableStreamDefaultReader<Uint8Array> =>
	new Blob([new Uint8Array(gzip)]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();

const readUpTo = Effect.fn("readUpTo")(function* readUpTo(read: Read, room: number) {
	const chunks: Uint8Array[] = [];
	let size = 0;

	for (;;) {
		const next = yield* Effect.tryPromise({
			catch: (): Unexpandable => "undecodable",
			try: read,
		});

		if (next.done) {
			return concat(chunks);
		}

		size += next.value.length;

		if (size > room) {
			return yield* undecodable;
		}

		chunks.push(next.value);
	}
});

const inflate = (gzip: Bytes, room: number): Effect.Effect<Uint8Array, Unexpandable> =>
	Effect.acquireUseRelease(
		Effect.sync(() => gunzip(gzip)),
		(reader) => readUpTo((): PromiseLike<Chunk> => reader.read(), room),
		(reader) =>
			Effect.ignore(
				Effect.tryPromise({ catch: () => "cancel failed", try: (): PromiseLike<void> => reader.cancel() }),
			),
	);

const utf8 = new TextDecoder("utf-8", { fatal: true });

const decodeUtf8 = Option.liftThrowable((bytes: Bytes) => utf8.decode(bytes));

const isControl = (byte: number): boolean =>
	(byte < byteValues.pastC0 &&
		byte !== byteValues.tab &&
		byte !== byteValues.lineFeed &&
		byte !== byteValues.carriageReturn) ||
	byte === byteValues.del;

const printable = (bytes: Bytes): Option.Option<string> => {
	if (bytes.some((byte) => isControl(byte))) {
		return Option.none();
	}

	return decodeUtf8(bytes);
};

const legacyDecoders = pipe(
	["utf-16le", "utf-16be", "latin1"] as const,
	Array.map((label) => new TextDecoder(label)),
);

const legacyReadings = (bytes: Bytes): string[] =>
	pipe(
		legacyDecoders,
		Array.map((decoder) => decoder.decode(bytes)),
	);

/**
 * A character text in that encoding would not hold: a control, a surrogate, a private-use or unassigned code point, or
 * a decoding error. NUL is allowed, since it pads ASCII read as UTF-16 and ends C strings.
 */
const outsideText = /[^\P{C}\p{Cf}\0\t\n\r]|\uFFFD/u;

const isText = (reading: string): boolean => !outsideText.test(reading);

const readsAsText = (bytes: Bytes): boolean =>
	Option.isSome(printable(bytes)) || pipe(legacyReadings(bytes), Array.some(isText));

const legible = (reading: string): string =>
	Str.replaceAll(/[^\P{Cc}\t\n\r]/gu, " ")(Str.replaceAll("\0", "")(reading));

/**
 * What the judge reads for decoded bytes: the text when they are printable UTF-8, else every legacy reading side by
 * side, since no test can tell which one is meant. Long bytes that read as text in no encoding have none.
 *
 * @param {Bytes} bytes Decoded bytes.
 * @returns {Option.Option<readonly string[]>} The readings, or none for binary.
 */
const readingsOf = (bytes: Bytes): Option.Option<readonly string[]> =>
	Option.orElse(Option.map(printable(bytes), Array.of), () => {
		const readings = legacyReadings(bytes);

		if (bytes.length <= shortBytes || pipe(readings, Array.some(isText))) {
			return Option.some(pipe(readings, Array.map(legible)));
		}

		return Option.none();
	});

const fromBase64Run = (run: string): Option.Option<Uint8Array> => {
	if (!looksBase64(run)) {
		return Option.none();
	}

	const bytes = fromBase64(run);

	if (readsAsWords(run)) {
		return pipe(bytes, Option.filter(readsAsText));
	}

	return bytes;
};

const decoders: readonly {
	readonly pattern: Readonly<RegExp>;
	readonly decode: (run: string) => Option.Option<Uint8Array>;
}[] = [
	{ decode: fromBase64Run, pattern: base64Run },
	{ decode: (run) => Result.getSuccess(Hex.decode(run)), pattern: gzipHex },
	{ decode: (run) => Option.some(fromPercent(run)), pattern: percentRun },
];

/**
 * Every payload one decoder finds in `text`, in the order they appear. Node's regex engine throws on a run of millions
 * of characters, such as a base64 run over about 5.59 million, so a search that cannot finish fails closed.
 *
 * @param {object} decoder The decoder's pattern and decoding.
 * @param {string} text A text as sent or a reading of a payload.
 * @returns {Effect.Effect} The decoded payloads.
 */
const payloadsIn = (decoder: (typeof decoders)[number], text: string): Effect.Effect<Uint8Array[], Unexpandable> =>
	Effect.try({
		catch: (): Unexpandable => "undecodable",
		try: () =>
			pipe(
				[...Str.matchAll(decoder.pattern)(text)],
				Array.map(([run]) => decoder.decode(run)),
				Array.getSomes,
			),
	});

/**
 * Turns each text into scannable text: the text followed by every reading of every payload decoded from it, recursively.
 * Fails closed as `binary` on decoded bytes over `shortBytes` that read as text in no encoding, and as `undecodable` on a
 * corrupt gzip, on more than `maxDecodedBytes` decoded, or on a payload that still decodes to text below `maxDepth`
 * levels.
 */
const expand = Effect.fn("expand")(function* expand(texts: readonly string[]) {
	let room = maxDecodedBytes;

	const bytesOf = Effect.fn("bytesOf")(function* bytesOf(encoded: Bytes) {
		let bytes: Bytes = encoded;

		if (isGzip(encoded)) {
			bytes = yield* inflate(encoded, room);
		}

		if (bytes.length > room) {
			return yield* undecodable;
		}

		room -= bytes.length;

		return bytes;
	});

	const decodedIn = (text: string, level: number): Effect.Effect<readonly string[], Unexpandable> =>
		Effect.gen(function* decoded() {
			const found: string[] = [];

			for (const decoder of decoders) {
				for (const encoded of yield* payloadsIn(decoder, text)) {
					const bytes = yield* bytesOf(encoded);
					const readings = yield* Effect.fromOption(readingsOf(bytes), () => "binary" as const);

					if (level === maxDepth) {
						return yield* undecodable;
					}

					for (const reading of readings) {
						found.push(reading, ...(yield* decodedIn(reading, Num.increment(level))));
					}
				}
			}

			return found;
		});

	return yield* Effect.forEach(
		texts,
		(text) => Effect.map(decodedIn(text, sentLevel), (decoded) => Array.join([text, ...decoded], "\n")),
		{ concurrency: 1 },
	);
});

export { expand };
