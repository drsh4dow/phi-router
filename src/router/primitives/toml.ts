import { Array, Option, Record, String as Str, pipe } from "effect";

interface Statement {
	readonly kind: "table" | "arrayOfTables" | "pair";
	readonly path: readonly string[];
	readonly value: string;
	readonly start: number;
	readonly end: number;
}

interface Token {
	readonly text: string;
	readonly end: number;
}

interface Group {
	readonly tokens: readonly Token[];
	readonly start: number;
	readonly end: number;
}

const boundaryTokenPattern =
	/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|#(?:[^\r\n]|\r(?!\n))*|\n|[[\]{}]|[^"'#\n[\]{}]+|["']/gu;

const keyPattern = /\s*(?:"(?<basic>(?:[^"\\]|\\.)*)"|'(?<literal>[^']*)'|(?<bare>[\w-]+))\s*(?:\.|$)/gu;

const quoted = /^["']/u;

const textStart = 0;

const level = 1;

const deeper = new Map([
	["[", level],
	["{", level],
	["]", -level],
	["}", -level],
]);

const isComment = (token: Token): boolean => Str.startsWith("#")(token.text);

const meaningful = (token: Token): boolean => !isComment(token) && Str.isNonEmpty(Str.trim(token.text));

const tokensOf = (text: string): readonly Token[] => {
	const texts = pipe(
		Array.fromIterable(Str.matchAll(boundaryTokenPattern)(text)),
		Array.map(([match]) => match),
	);

	const [, tokens] = Array.mapAccum(texts, textStart, (at, token) => [
		at + token.length,
		{ end: at + token.length, text: token },
	]);

	return tokens;
};

interface Place {
	readonly statementStart: number;
	readonly bracketDepth: number;
}

interface Placed {
	readonly token: Token;
	readonly statementStart: number;
	readonly endsStatement: boolean;
}

const placed = (place: Place, token: Token): readonly [Place, Placed] => {
	const endsStatement = token.text === "\n" && place.bracketDepth === textStart;

	if (endsStatement) {
		return [
			{ bracketDepth: place.bracketDepth, statementStart: token.end },
			{ endsStatement, statementStart: place.statementStart, token },
		];
	}

	const bracketDepth = Math.max(textStart, place.bracketDepth + (deeper.get(token.text) ?? textStart));

	return [
		{ bracketDepth, statementStart: place.statementStart },
		{ endsStatement, statementStart: place.statementStart, token },
	];
};

const groupsOf = (text: string): readonly Group[] => {
	const [, tokens] = Array.mapAccum(tokensOf(text), { bracketDepth: textStart, statementStart: textStart }, placed);

	return pipe(
		tokens,
		Array.groupBy(({ statementStart }) => String(statementStart)),
		Record.values,
		Array.map((group) => ({
			end: Array.lastNonEmpty(group).token.end,
			start: Array.headNonEmpty(group).statementStart,
			tokens: pipe(
				group,
				Array.filter(({ endsStatement }) => !endsStatement),
				Array.map(({ token }) => token),
			),
		})),
	);
};

const keyOf = (key: string): readonly string[] =>
	pipe(
		Array.fromIterable(Str.matchAll(keyPattern)(key)),
		Array.map(({ groups = {} }) => groups["basic"] ?? groups["literal"] ?? groups["bare"] ?? ""),
	);

const joined = (tokens: readonly Token[]): string =>
	pipe(
		tokens,
		Array.map(({ text }) => text),
		Array.join(""),
	);

const headerOf = (tokens: readonly Token[]): Pick<Statement, "kind" | "path"> => {
	const opened = pipe(
		tokens,
		Array.dropWhile((token) => !meaningful(token)),
	);

	const path = pipe(
		opened,
		Array.dropWhile((token) => token.text === "[" || !meaningful(token)),
		Array.takeWhile((token) => token.text !== "]"),
		joined,
		keyOf,
	);

	const brackets = pipe(
		opened,
		Array.takeWhile((token) => token.text === "["),
	);

	if (brackets.length > level) {
		return { kind: "arrayOfTables", path };
	}

	return { kind: "table", path };
};

const pairOf = (tokens: readonly Token[]): Pick<Statement, "path" | "value"> => {
	const signed = (token: Token): boolean => !quoted.test(token.text) && Str.includes("=")(token.text);

	const before = pipe(
		tokens,
		Array.takeWhile((token) => !signed(token)),
	);

	const [split = { end: textStart, text: "" }, ...after] = pipe(
		tokens,
		Array.dropWhile((token) => !signed(token)),
	);

	const [key, ...value] = Str.split(split.text, "=");

	const rest = pipe(
		after,
		Array.filter((token) => !isComment(token)),
		joined,
	);

	return { path: keyOf(`${joined(before)}${key}`), value: Str.trim(`${Array.join(value, "=")}${rest}`) };
};

const statementsOf = (text: string): readonly Statement[] => {
	const groups = pipe(
		groupsOf(text),
		Array.filter(({ tokens }) => pipe(tokens, Array.some(meaningful))),
	);

	const [, statements] = Array.mapAccum(
		groups,
		Array.empty<string>(),
		(table: readonly string[], { end, start, tokens }): [readonly string[], Statement] => {
			const opens = pipe(
				Array.findFirst(tokens, meaningful),
				Option.exists(({ text: first }) => first === "["),
			);

			if (opens) {
				const { kind, path } = headerOf(tokens);

				return [path, { end, kind, path, start, value: "" }];
			}

			const { path, value } = pairOf(tokens);

			return [table, { end, kind: "pair", path: [...table, ...path], start, value }];
		},
	);

	return statements;
};

export { statementsOf };

export type { Statement };
