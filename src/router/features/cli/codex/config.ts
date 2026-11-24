import { Array, Option, String as Str, pipe } from "effect";
import { codexSettings, dotted, provider } from "./settings.ts";
import type { Setting } from "./settings.ts";
import type { Statement } from "#router/primitives/toml.ts";
import { statementsOf } from "#router/primitives/toml.ts";

interface Cut {
	readonly text: string;
	readonly cutKeys: readonly string[];
}

const fileStart = 0;

const sameKey = Array.makeEquivalence(Str.Equivalence);

const under =
	(prefix: readonly string[]) =>
	(path: readonly string[]): boolean =>
		sameKey(Array.take(path, prefix.length), prefix);

const outsideProvider = (setting: Setting): boolean => !under(provider)(setting.path);

const settingOf = (statement: Statement): Option.Option<Setting> =>
	pipe(
		codexSettings,
		Array.findFirst(({ path }) => statement.kind === "pair" && sameKey(path, statement.path)),
	);

const ownMark = "# phi-router";

const keptMark = "# phi-router kept: ";

const keptLine = new RegExp(`^${keptMark}`, "gmu");

const lineStart = /^(?=.)/gmu;

const ours = (text: string, statement: Statement): boolean =>
	Str.endsWith(ownMark)(Str.trimEnd(Str.slice(statement.start, statement.end)(text)));

const replacesIt = (statement: Statement): boolean =>
	under(provider)(statement.path) || Option.isSome(settingOf(statement));

const blankAbove = /(?<=^|\n)(?:[\t ]*\r?\n)+$/u;

const cutFrom =
	(text: string) =>
	(statement: Statement): number => {
		if (statement.kind === "pair") {
			return statement.start;
		}

		const above = Str.slice(fileStart, statement.start)(text);

		return pipe(
			Option.fromNullishOr(blankAbove.exec(above)),
			Option.match({ onNone: () => statement.start, onSome: ([blank]) => statement.start - blank.length }),
		);
	};

const spelled = ({ kind, path }: Statement): string => {
	if (kind === "pair") {
		return dotted(path);
	}

	return `[${dotted(path)}]`;
};

interface Edit {
	readonly replacedFrom: number;
	readonly replacement: string;
}

const rewritten =
	(pick: (text: string, statement: Statement) => boolean, edit: (text: string, statement: Statement) => Edit) =>
	(text: string): Cut => {
		const picked = pipe(
			statementsOf(text),
			Array.filter((statement) => pick(text, statement)),
		);

		const [done] = Array.mapAccum(picked, { at: fileStart, text: "" }, (left, statement) => {
			const { replacedFrom, replacement } = edit(text, statement);
			const kept = Str.slice(left.at, Math.max(left.at, replacedFrom))(text);

			return [{ at: statement.end, text: `${left.text}${kept}${replacement}` }, statement];
		});

		return { cutKeys: pipe(picked, Array.map(spelled)), text: `${done.text}${Str.slice(done.at)(text)}` };
	};

const withoutOurs = rewritten(ours, (text, statement) => ({ replacedFrom: cutFrom(text)(statement), replacement: "" }));

const recorded = rewritten(
	(_text, statement) => replacesIt(statement),
	(text, statement) => ({
		replacedFrom: statement.start,
		replacement: Str.replaceAll(lineStart, keptMark)(Str.slice(statement.start, statement.end)(text)),
	}),
);

const inserted =
	(insert: { readonly at: number; readonly lines: readonly string[] }) =>
	(text: string): string => {
		const before = Str.slice(fileStart, insert.at)(text);
		const opened = Str.isEmpty(before) || Str.endsWith("\n")(before);
		const block = `${Array.join(insert.lines, "\n")}\n`;

		if (Array.isReadonlyArrayEmpty(insert.lines)) {
			return text;
		}

		if (opened) {
			return `${before}${block}${Str.slice(insert.at)(text)}`;
		}

		return `${before}\n${block}${Str.slice(insert.at)(text)}`;
	};

const lineIn =
	(table: readonly string[]) =>
	({ path, value }: Setting): string =>
		`${dotted(Array.drop(path, table.length))} = ${value} ${ownMark}`;

const inlineOwner = (text: string): Option.Option<string> =>
	pipe(
		statementsOf(text),
		Array.findFirst(
			({ kind, path }) =>
				kind === "pair" &&
				!under(provider)(path) &&
				pipe(
					codexSettings,
					Array.some((setting) => path.length < setting.path.length && under(path)(setting.path)),
				),
		),
		Option.map(({ path }) => dotted(path)),
	);

const inTable =
	(setting: Setting) =>
	(table: Statement): boolean =>
		pipe(
			Array.init(setting.path),
			Option.exists((parent) => sameKey(parent, table.path)),
		);

const isTable = ({ kind }: Statement): boolean => kind === "table";

const outside = pipe(codexSettings, Array.filter(outsideProvider));

const linesIn = (table: Statement): readonly string[] =>
	pipe(
		outside,
		Array.filter((setting) => inTable(setting)(table)),
		Array.map(lineIn(table.path)),
	);

const outsideWritten = (text: string): string => {
	const statements = statementsOf(text);

	const tables = pipe(statements, Array.filter(isTable));
	const tabled = (setting: Setting): boolean => pipe(tables, Array.some(inTable(setting)));

	const rootEnd = pipe(
		statements,
		Array.takeWhile(({ kind }) => kind === "pair"),
		Array.last,
		Option.match({ onNone: () => fileStart, onSome: ({ end }) => end }),
	);

	const atRoot = pipe(
		outside,
		Array.filter((setting) => !tabled(setting)),
		Array.map(lineIn([])),
	);

	let file = text;

	for (const table of Array.reverse(tables)) {
		file = inserted({ at: table.end, lines: linesIn(table) })(file);
	}

	return inserted({ at: rootEnd, lines: atRoot })(file);
};

const switchedOn = (text: string): string => {
	const written = outsideWritten(recorded(withoutOurs(text).text).text);

	const lines = pipe(
		codexSettings,
		Array.filter((setting) => !outsideProvider(setting)),
		Array.map(lineIn(provider)),
	);

	return inserted({ at: written.length, lines: ["", `[${dotted(provider)}] ${ownMark}`, ...lines] })(written);
};

const switchedOff = (text: string): Cut => {
	const cut = withoutOurs(text);

	return { cutKeys: cut.cutKeys, text: Str.replaceAll(keptLine, "")(cut.text) };
};

export { inlineOwner, switchedOff, switchedOn, under };
