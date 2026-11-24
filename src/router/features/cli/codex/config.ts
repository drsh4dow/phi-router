import { Array, Option, String as Str, pipe } from "effect";
import { codexSettings, dotted, provider } from "./settings.ts";
import type { Setting } from "./settings.ts";
import type { Statement } from "#router/primitives/toml.ts";
import { statementsOf } from "#router/primitives/toml.ts";

/** The text left once statements are cut, and the dotted key of each statement cut. */
interface Cut {
	readonly text: string;
	readonly removed: readonly string[];
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

/** The comment that ends each line `on codex` writes. It is the record of what `off` removes. */
const ownMark = "# phi-router";

/** What `on codex` puts before each line of a statement of the developer's that it replaces, the record `off` restores. */
const keptMark = "# phi-router kept: ";

const keptLine = new RegExp(`^${keptMark}`, "gmu");

const lineStart = /^(?=.)/gmu;

/**
 * Whether `on codex` wrote the statement: its last line ends with {@link ownMark}.
 *
 * @param {string} text The file.
 * @param {Statement} statement The statement.
 * @returns {boolean} Whether `on` wrote it.
 */
const ours = (text: string, statement: Statement): boolean =>
	Str.endsWith(ownMark)(Str.trimEnd(Str.slice(statement.start, statement.end)(text)));

/**
 * A statement that `on codex` replaces: anything under the provider, and a setting's pair whatever its value.
 *
 * @param {Statement} statement The statement.
 * @returns {boolean} Whether `on` replaces it.
 */
const replacesIt = (statement: Statement): boolean =>
	under(provider)(statement.path) || Option.isSome(settingOf(statement));

const blankAbove = /(?<=^|\n)(?:[\t ]*\r?\n)+$/u;

/**
 * Where a statement's cut starts: a header takes the blank lines above it along, since `on` writes one there.
 *
 * @param {string} text The file.
 * @returns {Function} Where the cut of a statement starts.
 */
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

/** Where the text of a statement starts to change, and what takes its place up to the statement's end. */
interface Edit {
	readonly from: number;
	readonly by: string;
}

const rewritten =
	(pick: (text: string, statement: Statement) => boolean, edit: (text: string, statement: Statement) => Edit) =>
	(text: string): Cut => {
		const picked = pipe(
			statementsOf(text),
			Array.filter((statement) => pick(text, statement)),
		);

		const [done] = Array.mapAccum(picked, { at: fileStart, text: "" }, (left, statement) => {
			const { by, from } = edit(text, statement);
			const kept = Str.slice(left.at, Math.max(left.at, from))(text);

			return [{ at: statement.end, text: `${left.text}${kept}${by}` }, statement];
		});

		return { removed: pipe(picked, Array.map(spelled)), text: `${done.text}${Str.slice(done.at)(text)}` };
	};

const withoutOurs = rewritten(ours, (text, statement) => ({ by: "", from: cutFrom(text)(statement) }));

/**
 * `text` with each statement `on codex` replaces turned into lines of {@link keptMark}, so `off` can restore it. It runs
 * on a file {@link withoutOurs} already cleared, so every statement it records is the developer's.
 */
const recorded = rewritten(
	(_text, statement) => replacesIt(statement),
	(text, statement) => ({
		by: Str.replaceAll(lineStart, keptMark)(Str.slice(statement.start, statement.end)(text)),
		from: statement.start,
	}),
);

/**
 * `text` with `lines` put in at `at`, each on a line of its own.
 *
 * @param {object} insert Where the lines go, and the lines.
 * @returns {Function} The file with them.
 */
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

/**
 * The first pair that holds a table `on` writes into as one value, such as `model_providers = { ... }`, which `on`
 * cannot add a line to.
 *
 * @param {string} text The file.
 * @returns {Option.Option<string>} Its dotted key.
 */
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

/**
 * `text` with each setting outside the provider in the table that holds its key when the file has one, such as
 * `[features]`, and the rest after the last root pair.
 *
 * @param {string} text The file.
 * @returns {string} The file with them.
 */
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

/**
 * `config.toml` with each setting written once, whatever it held before: each setting in the table that holds its key
 * when one exists, the rest after the last root pair, and the provider's table at the end, each line ending with
 * {@link ownMark}. A statement of the developer's that a setting replaces stays where it was, behind {@link keptMark}.
 * Every other line is kept as it was.
 *
 * @param {string} text The file. It holds no pair {@link inlineOwner} names.
 * @returns {string} The file with the settings.
 */
const switchedOn = (text: string): string => {
	const written = outsideWritten(recorded(withoutOurs(text).text).text);

	const lines = pipe(
		codexSettings,
		Array.filter((setting) => !outsideProvider(setting)),
		Array.map(lineIn(provider)),
	);

	return inserted({ at: written.length, lines: ["", `[${dotted(provider)}] ${ownMark}`, ...lines] })(written);
};

/**
 * `config.toml` without the lines `on codex` wrote, and with each statement it replaced back as it was.
 *
 * @param {string} text The file.
 * @returns {Cut} The file left, and the keys removed.
 */
const switchedOff = (text: string): Cut => {
	const cut = withoutOurs(text);

	return { removed: cut.removed, text: Str.replaceAll(keptLine, "")(cut.text) };
};

export { inlineOwner, switchedOff, switchedOn, under };
