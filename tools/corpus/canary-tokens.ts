import { Array, Effect, Option, Record, Result, String as Str, pipe } from "effect";
import { Base64, Hex } from "effect/encoding";
import type { Case } from "./manifest.ts";
import { sentTextsOf } from "./wire.ts";

interface Split {
	readonly canary: string;
	readonly parts: readonly string[];
}

interface Tracked {
	readonly wholeCanaryTokens: readonly string[];
	readonly splits: readonly Split[];
	readonly fragments: readonly string[];
	readonly sealedWindows: readonly string[];
	readonly untracked: readonly string[];
}

type Bytes = Readonly<Uint8Array<Readonly<ArrayBufferLike>>>;

interface Window {
	readonly start: number;
	readonly window: string;
}

const textStart = 0;

const splitPartContextChars = 40;

const sealedWidth = 40;

const gzipMagic = { first: 31, second: 139 } as const;

const base64Run = /[A-Za-z0-9+/]{24,}={0,2}/gu;

const hexRun = /(?:[0-9a-fA-F]{2}){12,}/gu;

const textDecoder = new TextDecoder();

const isGzip = (bytes: Bytes): boolean => {
	const [first, second] = bytes;

	return first === gzipMagic.first && second === gzipMagic.second;
};

const inflated = (bytes: Bytes): PromiseLike<string> =>
	new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"))).text();

const textOfBytes = (bytes: Bytes): Effect.Effect<Option.Option<string>> => {
	if (isGzip(bytes)) {
		return Effect.option(Effect.tryPromise({ catch: () => "not gzip" as const, try: () => inflated(bytes) }));
	}

	return Effect.succeedSome(textDecoder.decode(bytes));
};

const bytesHold = (bytes: Bytes, canary: string): Effect.Effect<boolean> => {
	const includesCanary = Str.includes(canary);

	return pipe(textOfBytes(bytes), Effect.map(Option.exists(includesCanary)));
};

const runsOf = (text: string): { readonly bytes: ReturnType<typeof Hex.decode>; readonly run: string }[] => [
	...pipe(
		[...Str.matchAll(base64Run)(text)],
		Array.map(([run]) => ({ bytes: Base64.decode(run), run })),
	),
	...pipe(
		[...Str.matchAll(hexRun)(text)],
		Array.map(([run]) => ({ bytes: Hex.decode(run), run })),
	),
];

const encoded = Effect.fnUntraced(function* encoded(canary: string, texts: readonly string[]) {
	const found = yield* Effect.findFirst(pipe(texts, Array.flatMap(runsOf)), ({ bytes }) =>
		Result.match(bytes, {
			onFailure: () => Effect.succeed(false),
			onSuccess: (decoded) => bytesHold(decoded, canary),
		}),
	);

	return pipe(
		found,
		Option.map(({ run }) => [run]),
	);
});

const partToken = (part: string, texts: readonly string[]): Option.Option<string> =>
	pipe(
		texts,
		Array.findFirst((text) =>
			pipe(
				Str.indexOf(part)(text),
				Option.map((at) =>
					Str.slice(
						Math.max(textStart, at - splitPartContextChars),
						at + part.length + splitPartContextChars,
					)(text),
				),
			),
		),
	);

const splitOf = (subject: Case, canary: string, texts: readonly string[]): Option.Option<Split> => {
	if (subject.expect !== "phi") {
		return Option.none();
	}

	return pipe(
		Option.fromUndefinedOr(subject.canaryParts),
		Option.flatMap(Record.get(canary)),
		Option.flatMap((parts) => {
			const tokens = pipe(
				parts,
				Array.map((part) => partToken(part, texts)),
				Array.getSomes,
			);

			return Option.liftPredicate({ canary, parts: tokens }, () => tokens.length === parts.length);
		}),
	);
};

const isOneLine = ({ window }: Window): boolean => !Str.includes("\n")(window);

const spansOf = (text: string, canary: string): { readonly from: number; readonly to: number }[] =>
	pipe(
		Array.range(textStart, text.length - canary.length),
		Array.filter((at) => Str.startsWith(canary, at)(text)),
		Array.map((at) => ({ from: at, to: at + canary.length })),
	);

const distinctive = (text: string, canaries: readonly string[], others: readonly string[]): Option.Option<string> => {
	const taken = pipe(
		canaries,
		Array.flatMap((canary) => spansOf(text, canary)),
	);

	const windows = pipe(
		Array.range(textStart, Math.max(textStart, text.length - sealedWidth)),
		Array.map((start) => ({ start, window: Str.slice(start, start + sealedWidth)(text) })),
	);

	const isClear = ({ start }: Window): boolean =>
		!pipe(
			taken,
			Array.some(({ from, to }) => start < to && from < start + sealedWidth),
		);

	const first = (keep: (window: Window) => boolean): Option.Option<Window> =>
		pipe(
			windows,
			Array.findFirst((each) => keep(each) && !pipe(others, Array.some(Str.includes(each.window)))),
		);

	return pipe(
		first((each) => isClear(each) && isOneLine(each)),
		Option.orElse(() => first(isClear)),
		Option.orElse(() => first(() => true)),
		Option.map(({ window }) => window),
	);
};

const imagesOf = (subject: Case): string[] =>
	pipe(
		subject.messages,
		Array.flatMap((message) => {
			if ("image" in message) {
				return [message.image.data];
			}

			return [];
		}),
	);

const wholeIn = (texts: readonly string[], canary: string): Option.Option<string[]> =>
	Option.liftPredicate([canary], () => pipe(texts, Array.some(Str.includes(canary))));

const sealedOf = (sent: readonly string[], wholeTokens: readonly string[]): string[] => {
	const holdsComplete = (text: string): boolean =>
		pipe(
			wholeTokens,
			Array.some((token) => Str.includes(token)(text)),
		);

	const others = pipe(
		sent,
		Array.filter((text) => !holdsComplete(text)),
	);

	return pipe(
		sent,
		Array.filter(holdsComplete),
		Array.flatMap((text) => Option.toArray(distinctive(text, wholeTokens, others))),
	);
};

const tokensOf = Effect.fn("tokensOf")(function* tokensOf(subject: Case) {
	const texts = sentTextsOf(subject);
	const sent = [...texts, ...imagesOf(subject)];

	const found = yield* Effect.forEach(
		subject.canaries,
		(canary) =>
			pipe(
				encoded(canary, texts),
				Effect.map((run) => ({
					canary,
					split: splitOf(subject, canary, texts),
					wholeTokens: Option.orElse(wholeIn(sent, canary), () => run),
				})),
			),
		{ concurrency: 1 },
	);

	const wholeCanaryTokens = pipe(
		found,
		Array.flatMap(({ wholeTokens: tokens }) => Option.getOrElse(tokens, () => [])),
	);

	return {
		fragments: subject.fragments,
		sealedWindows: sealedOf(sent, wholeCanaryTokens),
		splits: pipe(
			found,
			Array.flatMap(({ split }) => Option.toArray(split)),
		),
		untracked: pipe(
			found,
			Array.filter(({ wholeTokens: tokens, split }) => Option.isNone(tokens) && Option.isNone(split)),
			Array.map(({ canary }) => canary),
		),
		wholeCanaryTokens,
	} satisfies Tracked;
});

export { tokensOf };

export type { Split, Tracked };
