import { Array, Number as Num, Option, Record, String as Str, pipe } from "effect";
import { Base64, Hex } from "effect/encoding";
import { compactJson, gzip, prettyJson } from "./encodings.ts";
import type { Random } from "./random.ts";
import { uuid } from "./record.ts";

const typo = { lettersKeptAtEnd: 1, lettersKeptAtStart: 1, touchedLetters: 2 } as const;

const longWordTypoShare = 0.3;

const aroundLongWords = /(?<word>\p{L}{5,})/u;

const receiptHandleHexDigits = 24;

const md5HexDigits = 32;

const kafkaPartitions = 12;

const kafkaOffsetDigits = 6;

const outboxIdDigits = 5;

const halves = 2;

const payloadStart = 0;

const misspell = (rng: Random, word: string): string => {
	const at = rng.between(typo.lettersKeptAtStart, word.length - typo.touchedLetters - typo.lettersKeptAtEnd);
	const next = Num.increment(at);

	const [head, here, after, tail] = [
		Str.takeLeft(at)(word),
		word[at] ?? "",
		word[next] ?? "",
		Str.slice(Num.increment(next))(word),
	];

	return rng.pick([`${head}${after}${here}${tail}`, `${head}${after}${tail}`, `${head}${here}${here}${after}${tail}`]);
};

const isKeyword = (word: string): boolean => /^\p{Lu}+$/u.test(word);

const isLongWord = (piece: string): boolean => /^\p{L}{5,}$/u.test(piece);

const misspellWords = (rng: Random, text: string): string =>
	pipe(
		Str.split(aroundLongWords)(text),
		Array.map((piece) => {
			if (!isLongWord(piece) || isKeyword(piece) || !rng.chance(longWordTypoShare)) {
				return piece;
			}

			return misspell(rng, piece);
		}),
		Array.join(""),
	);

const withTypos =
	({ rng, canaries }: { readonly rng: Random; readonly canaries: readonly string[] }) =>
	(text: string): string => {
		let pieces = [text];

		for (const canary of canaries) {
			pieces = pipe(
				pieces,
				Array.flatMap((piece) => Array.intersperse(Str.split(canary)(piece), canary)),
			);
		}

		const typed = pipe(
			pieces,
			Array.map((piece) => {
				if (Array.contains(canaries, piece)) {
					return piece;
				}

				return misspellWords(rng, piece);
			}),
		);

		return Array.join(typed, "");
	};

const asBase64 =
	({ rng, mimeType }: { readonly rng: Random; readonly mimeType: string }) =>
	(payload: string): string => {
		const data = Base64.encode(payload);

		const envelopes: Array.NonEmptyReadonlyArray<() => string> = [
			() =>
				prettyJson(
					Record.fromEntries([
						["resourceType", "Binary"],
						["id", uuid(rng)],
						["contentType", mimeType],
						["data", data],
					]),
				),
			() => {
				const message = Record.fromEntries([
					["MessageId", uuid(rng)],
					["ReceiptHandle", rng.hex(receiptHandleHexDigits)],
					["MD5OfBody", rng.hex(md5HexDigits)],
					["Body", data],
				]);

				return prettyJson(Record.fromEntries([["Messages", [message]]]));
			},
			() =>
				Array.join(
					[
						`Content-Type: ${mimeType}; name="export.dat"`,
						"Content-Transfer-Encoding: base64",
						`Content-Disposition: attachment; filename="export.dat"`,
						"",
						data,
					],
					"\n",
				),
			() =>
				`% Topic: claims.raw Partition: ${String(rng.int(kafkaPartitions))} Offset: ${rng.digits(kafkaOffsetDigits)}\n${data}`,
		];

		return rng.pick(envelopes)();
	};

const asGzipHex =
	(rng: Random) =>
	(payload: string): string => {
		const data = Hex.encode(gzip(payload));
		const id = rng.digits(outboxIdDigits);

		const envelopes: Array.NonEmptyReadonlyArray<() => string> = [
			() => ` id    | encoding | payload\n-------+----------+---------\n ${id} | gzip     | \\x${data}\n(1 row)`,
			() => `outbox_event id=${uuid(rng)} encoding=gzip payload_hex=${data}`,
			() => `>>> row["payload"].hex()\n'${data}'`,
			() =>
				compactJson(
					Record.fromEntries([
						["id", Number(id)],
						["contentEncoding", "gzip"],
						["payloadHex", data],
					]),
				),
		];

		return rng.pick(envelopes)();
	};

interface Split {
	readonly payloadHalves: readonly [string, string];
	readonly canaryParts: readonly [string, string];
}

const splitPayload = ({ payload, canary }: { readonly payload: string; readonly canary: string }): Split => {
	const start = Option.getOrElse(Str.indexOf(canary)(payload), () => payloadStart);
	const at = start + Math.floor(canary.length / halves);

	return {
		canaryParts: [Str.takeLeft(at - start)(canary), Str.slice(at - start)(canary)],
		payloadHalves: [Str.takeLeft(at)(payload), Str.slice(at)(payload)],
	};
};

export { asBase64, asGzipHex, splitPayload, withTypos };
