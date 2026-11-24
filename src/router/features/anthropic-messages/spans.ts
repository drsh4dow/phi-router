import { Array, Effect, Option, Schema, String as Str, pipe } from "effect";
import { JsonString, isForwarded } from "./wire.ts";

interface Span {
	readonly body: string;
	readonly start: number;
	readonly end: number;
	readonly members: readonly Member[];
	readonly items: readonly Span[];
}

interface Member {
	readonly key: string;
	readonly keyStart: number;
	readonly value: Span;
}

/** One replacement in the body text. The edits of one lane never overlap. */
interface Edit {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

interface Located<Wire> {
	readonly wire: Wire;
	readonly span: Span;
}

interface Token {
	readonly start: number;
	readonly end: number;
	readonly text: string;
	readonly betweenQuotes: string;
}

interface Scanned {
	readonly span: Span;
	readonly repeated: Option.Option<string>;
	readonly escaped: readonly string[];
}

const tokenPattern =
	/(?<blank>[\t\n\r ]*)(?<token>"(?<betweenQuotes>[^"\\]*(?:\\.[^"\\]*)*)"|[,:[\]{}]|[^\t\n\r ,:[\]{}]+)/gu;

const textStart = 0;

const rootPath = "$";

const decodeKey = Schema.decodeEffect(JsonString);

const closes = (token: Token): boolean => token.text === "}" || token.text === "]" || Str.isEmpty(token.text);

const tokensOf = (source: string): readonly Token[] => {
	const matches = Array.fromIterable(Str.matchAll(tokenPattern)(source));

	const [, tokens] = Array.mapAccum(matches, textStart, (at, match) => {
		const { betweenQuotes = "", blank = "", token = "" } = match.groups ?? {};
		const start = at + blank.length;
		const end = start + token.length;

		return [end, { betweenQuotes, end, start, text: token }];
	});

	return tokens;
};

class Scan {
	readonly #parsedJson: string;

	readonly #decodedKeys: ReadonlyMap<string, string>;

	readonly #tokens: Iterator<Token, undefined>;

	readonly #end: Token;

	readonly #repeated: string[] = [];

	readonly #escaped = new Set<string>();

	public constructor(parsedJson: string, decodedKeys: readonly (readonly [string, string])[]) {
		this.#parsedJson = parsedJson;
		this.#decodedKeys = new Map(decodedKeys);
		this.#tokens = tokensOf(parsedJson)[Symbol.iterator]();
		this.#end = { betweenQuotes: "", end: parsedJson.length, start: parsedJson.length, text: "" };
	}

	public scanned(): Scanned {
		const span = this.#value(this.#next(), rootPath);

		return { escaped: Array.fromIterable(this.#escaped), repeated: Array.head(this.#repeated), span };
	}

	#next(): Token {
		const next = this.#tokens.next();

		if (next.done === true) {
			return this.#end;
		}

		return next.value;
	}

	#pastComma(): Token {
		const token = this.#next();

		if (token.text === ",") {
			return this.#next();
		}

		return token;
	}

	#value(first: Token, path: string): Span {
		if (first.text === "{") {
			return this.#object(first, path);
		}

		if (first.text === "[") {
			return this.#array(first, path);
		}

		return { body: this.#parsedJson, end: first.end, items: [], members: [], start: first.start };
	}

	#keyOf(token: Token): string {
		if (!Str.includes("\\")(token.betweenQuotes)) {
			return token.betweenQuotes;
		}

		return Option.getOrElse(Option.fromNullishOr(this.#decodedKeys.get(token.text)), () => {
			this.#escaped.add(token.text);

			return token.text;
		});
	}

	#member(key: Token, path: string): Member {
		this.#next();

		return { key: this.#keyOf(key), keyStart: key.start, value: this.#value(this.#next(), `${path}[${key.text}]`) };
	}

	#object(open: Token, path: string): Span {
		const members: Member[] = [];
		let token = this.#next();

		while (!closes(token)) {
			members.push(this.#member(token, path));
			token = this.#pastComma();
		}

		const keys = new Set(
			pipe(
				members,
				Array.map((member) => member.key),
			),
		);

		if (keys.size < members.length) {
			this.#repeated.push(path);
		}

		return { body: this.#parsedJson, end: token.end, items: [], members, start: open.start };
	}

	#array(open: Token, path: string): Span {
		const items: Span[] = [];
		let token = this.#next();

		while (!closes(token)) {
			items.push(this.#value(token, `${path}[${String(items.length)}]`));
			token = this.#pastComma();
		}

		return { body: this.#parsedJson, end: token.end, items, members: [], start: open.start };
	}
}

const spanOf = Effect.fnUntraced(function* spanOf(parsedJson: string): Effect.fn.Return<Span, string> {
	const first = new Scan(parsedJson, []).scanned();

	const keys = yield* Effect.forEach(
		first.escaped,
		(raw) => Effect.map(Effect.orDie(decodeKey(raw)), (key) => [raw, key] as const),
		{ concurrency: 1 },
	);

	let scan = first;

	if (Array.isReadonlyArrayNonEmpty(keys)) {
		scan = new Scan(parsedJson, keys).scanned();
	}

	return yield* Option.match(scan.repeated, {
		onNone: () => Effect.succeed(scan.span),
		onSome: (path) => Effect.fail(`a key appears twice in the object at ${path}`),
	});
});

const textOf = (span: Span): string => Str.slice(span.start, span.end)(span.body);

/**
 * Each parsed value beside its span. The parse and the scan read one text, so both lists have one entry per value.
 *
 * @param {readonly Span[]} spans The values' spans.
 * @returns {Function} Pairs each parsed value with its span.
 */
const locate =
	(spans: readonly Span[]) =>
	<Wire>(values: readonly Wire[]): readonly Located<Wire>[] =>
		Array.zipWith(values, spans, (wire, span) => ({ span, wire }));

const memberOf =
	(key: string) =>
	(object: Span): Option.Option<Member> =>
		pipe(
			object.members,
			Array.findFirst((member) => member.key === key),
		);

const valueOf =
	(key: string) =>
	(object: Span): Option.Option<Span> =>
		pipe(
			memberOf(key)(object),
			Option.map((member) => member.value),
		);

/**
 * The items under `key`, or none when the object has no such member.
 *
 * @param {string} key The member's key.
 * @returns {Function} The items' spans in an object.
 */
const itemsOf =
	(key: string) =>
	(object: Span): readonly Span[] =>
		pipe(valueOf(key)(object), Option.match({ onNone: () => [], onSome: (value) => value.items }));

/**
 * The members of `object` that a rewrite carries onto the block or message it writes in its place, as text, such as
 * `"cache_control":{"type":"ephemeral"}`: only those `forwarded` names, whose shapes the decode checked.
 *
 * @param {Span} object The block or message.
 * @returns {readonly string[]} Its forwarded members' text.
 */
const kept = (object: Span): readonly string[] =>
	pipe(
		object.members,
		Array.filter((member) => isForwarded(member.key)),
		Array.map((member) => Str.slice(member.keyStart, member.value.end)(object.body)),
	);

/** A value the strict parse proved present. Its absence means the scan and the parse read different texts. */
const required = Effect.fnUntraced(function* required(object: Span, key: string): Effect.fn.Return<Span> {
	return yield* Option.match(valueOf(key)(object), {
		onNone: () => Effect.die(`the scan of the body has no ${key} where the parse had one`),
		onSome: Effect.succeed,
	});
});

export { itemsOf, kept, locate, required, spanOf, textOf, valueOf };

export type { Edit, Located, Span };
