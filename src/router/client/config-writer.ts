import { Array, Effect, FileSystem, Option, Predicate, Schema, Struct, pipe } from "effect";
import type { Lane, Vendor } from "./lane-configuration.ts";
import { LaneFile } from "./lane-configuration.ts";
import { UserDirectories } from "effect/persistence";
import { configFile } from "./configuration.ts";
import { realFolder } from "./processes.ts";
import { writePrivately } from "./private-file.ts";

/**
 * An account `accounts add` or `setup` puts on a lane: a login folder, a command that prints a key, the login the
 * harness forwards, or a key file `setup` saved. Never the key.
 */
type NewAccount =
	| { readonly vendor: Vendor; readonly loginFolder: string }
	| { readonly vendor: Vendor; readonly keyCommand: string; readonly scheme: "apiKey" | "oauth" }
	| { readonly vendor: Vendor; readonly forwarded: true }
	| { readonly vendor: Vendor; readonly keyFile: string; readonly scheme: "apiKey" };

/** One account an edit puts on one lane. */
interface Wanted {
	readonly lane: Lane;
	readonly account: NewAccount;
}

/** What one edit adds: accounts, each on its lane, and the judge `setup` names when the file names none. */
interface Additions {
	readonly accounts: Array.NonEmptyReadonlyArray<Wanted>;
	readonly judge?: { readonly endpoint: string; readonly keyFile: string };
}

/** Where an add put an account: its name, whether it is new, and the account of its vendor before it on the lane. */
interface Placed {
	readonly name: string;
	readonly added: boolean;
	readonly after: Option.Option<string>;
	readonly lane: Lane;
}

/** `config.json` as an add edits it: the two lanes' entries as written, beside every other field as it was. */
const Written = Schema.optionalKey(Schema.Array(Schema.Json));

const Editable = Schema.fromJsonString(
	Schema.StructWithRest(Schema.Struct({ clean: Written, sealed: Written }), [
		Schema.Record(Schema.String, Schema.Json),
	]),
	{ space: "\t" },
);

const Listed = Schema.Array(
	Schema.Struct({
		forwarded: Schema.optionalKey(Schema.Boolean),
		keyCommand: Schema.optionalKey(Schema.String),
		keyFile: Schema.optionalKey(Schema.String),
		loginFolder: Schema.optionalKey(Schema.String),
		name: Schema.String,
		vendor: Schema.String,
	}),
);

const Lanes = Schema.Struct({ clean: Schema.optionalKey(Listed), sealed: Schema.optionalKey(Listed) });

type Entry = (typeof Listed.Type)[number];

const firstNumber = 1;

/**
 * The first `<word>-<n>` no account uses, where a bare `<word>` takes 1.
 *
 * @param {string} word The vendor's word for the account.
 * @param {readonly string[]} names Every account's name, on both lanes.
 * @param {number} at The number to try.
 * @returns {string} The name.
 */
const freeName = (word: string, names: readonly string[], at = firstNumber): string => {
	const name = `${word}-${String(at)}`;

	if (Array.contains(names, name) || (at === firstNumber && Array.contains(names, word))) {
		return freeName(word, names, at + firstNumber);
	}

	return name;
};

const wordOf = (account: NewAccount): string => {
	if (account.vendor === "anthropic") {
		return "claude";
	}

	if ("loginFolder" in account || "forwarded" in account) {
		return "codex";
	}

	return "openai";
};

const sameSource = (entry: Entry, account: NewAccount): boolean => {
	if ("loginFolder" in account) {
		return entry.loginFolder === account.loginFolder;
	}

	if ("forwarded" in account) {
		return entry.forwarded === true && entry.vendor === account.vendor;
	}

	if ("keyFile" in account) {
		return entry.keyFile === account.keyFile;
	}

	return entry.keyCommand === account.keyCommand;
};

const textOf = Effect.fnUntraced(function* textOf(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const exists = yield* fs.exists(file);

	if (!exists) {
		return "{}";
	}

	return yield* fs.readFileString(file);
});

/** Writes `text` over `file` through the private writer, once the router's decoder takes it. */
const saved = Effect.fnUntraced(function* saved(file: string, text: string) {
	yield* Schema.decodeEffect(LaneFile)(text);
	yield* writePrivately(file, `${text}\n`);
});

/** A lane entry with its login folder, when it has one, at its real path. */
const atRealPath = Effect.fnUntraced(function* atRealPath(entry: Entry) {
	if (Predicate.isUndefined(entry.loginFolder)) {
		return entry;
	}

	const loginFolder = yield* realFolder(entry.loginFolder);

	return Struct.assign(entry, { loginFolder });
});

/** The lanes with each login folder at its real path. */
const realLanes = Effect.fnUntraced(function* realLanes(lanes: typeof Lanes.Type) {
	const clean = yield* Effect.forEach(lanes.clean ?? [], atRealPath, { concurrency: 1 });
	const sealed = yield* Effect.forEach(lanes.sealed ?? [], atRealPath, { concurrency: 1 });

	return { clean, sealed };
});

const bothLanes: readonly Lane[] = ["clean", "sealed"];

const placedIn = (lanes: Editing["lanes"], lane: Lane, account: NewAccount): Placed => {
	const listed = lanes[lane] ?? [];

	const same = pipe(
		bothLanes,
		Array.findFirst((on) =>
			pipe(
				lanes[on] ?? [],
				Array.findFirst((entry) => sameSource(entry, account)),
				Option.map((entry): Placed => ({ added: false, after: Option.none(), lane: on, name: entry.name })),
			),
		),
	);

	if (Option.isSome(same)) {
		return same.value;
	}

	const names = pipe(
		[...(lanes.clean ?? []), ...(lanes.sealed ?? [])],
		Array.map((entry) => entry.name),
	);

	const after = pipe(
		listed,
		Array.findLast((entry) => entry.vendor === account.vendor),
		Option.map((entry) => entry.name),
	);

	return { added: true, after, lane, name: freeName(wordOf(account), names) };
};

/** The file as an edit goes: as written, and its lanes as the edit reads them. */
interface Editing {
	readonly edited: typeof Editable.Type;
	readonly lanes: Readonly<Partial<Record<Lane, readonly Entry[]>>>;
}

/**
 * Appends each of `additions.accounts` to its lane in `config.json` under the XDG config folder, a missing file read as
 * `{}`, names its judge when the file names none, and keeps every other field as it was, in one write. An account is
 * named after its vendor, `claude-<n>`, `codex-<n>` or `openai-<n>`, with the first number no account uses. An entry on
 * either lane with the same command, key file, forwarded vendor, or folder by real path, keeps the account out. With
 * nothing to add, it writes nothing. A file the router would refuse fails with the decoder's error and is not written. The one
 * writer of `config.json`.
 */
const addAccounts = Effect.fn("addAccounts")(function* addAccounts(additions: Additions) {
	const file = yield* Effect.provideService(configFile, UserDirectories.UserDirectories, UserDirectories.make());
	const read = yield* Effect.flatMap(textOf(file), Schema.decodeEffect(Editable));
	const lanes = yield* Effect.flatMap(Schema.decodeUnknownEffect(Lanes)(read), realLanes);

	const [added, placed] = pipe(
		additions.accounts,
		Array.mapAccum({ edited: read, lanes }, (editing, { account, lane }): readonly [Editing, Placed] => {
			const place = placedIn(editing.lanes, lane, account);

			if (!place.added) {
				return [editing, place];
			}

			const entry = Struct.assign({ name: place.name }, account);

			const next = {
				edited: Struct.assign(editing.edited, { [lane]: [...(editing.edited[lane] ?? []), entry] }),
				lanes: Struct.assign(editing.lanes, { [lane]: [...(editing.lanes[lane] ?? []), entry] }),
			};

			return [next, place];
		}),
	);

	const judge = pipe(
		Option.fromUndefinedOr(additions.judge),
		Option.filter(() => !("judge" in read)),
	);

	const anyAdded = Array.findFirst(placed, ({ added: isNew }) => isNew);

	if (Option.isSome(judge) || Option.isSome(anyAdded)) {
		const edited = Option.match(judge, {
			onNone: () => added.edited,
			onSome: (named) => Struct.assign(added.edited, { judge: named }),
		});

		yield* Effect.flatMap(Schema.encodeEffect(Editable)(edited), (text) => saved(file, text));
	}

	return placed;
});

export { addAccounts };

export type { NewAccount, Placed };
