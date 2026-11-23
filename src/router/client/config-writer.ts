import { Array, Effect, FileSystem, Option, Predicate, Schema, Struct, pipe } from "effect";
import type { Lane, Vendor } from "./lane-configuration.ts";
import { LaneFile } from "./lane-configuration.ts";
import { UserDirectories } from "effect/persistence";
import { configFile } from "./configuration.ts";
import { realFolder } from "./processes.ts";
import { writePrivately } from "./private-file.ts";

/** An account `accounts add` puts on a lane: a login folder, or a command that prints a key. Never the key. */
type NewAccount =
	| { readonly vendor: Vendor; readonly loginFolder: string }
	| { readonly vendor: Vendor; readonly keyCommand: string; readonly scheme: "apiKey" | "oauth" };

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
		keyCommand: Schema.optionalKey(Schema.String),
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

	if ("loginFolder" in account) {
		return "codex";
	}

	return "openai";
};

const sameSource = (entry: Entry, account: NewAccount): boolean => {
	if ("loginFolder" in account) {
		return entry.loginFolder === account.loginFolder;
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

const placedIn = (lanes: typeof Lanes.Type, lane: Lane, account: NewAccount): Placed => {
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

/**
 * Appends `account` to `lane` in `config.json` under the XDG config folder, a missing file read as `{}`, and keeps
 * every other field as it was. The account is named after its vendor, `claude-<n>`, `codex-<n>` or `openai-<n>`, with
 * the first number no account uses. An entry on either lane with the same command, or the same folder by real path,
 * leaves the file as it was. A file the router would refuse fails with the decoder's error and is not written. The one
 * writer of `config.json`.
 */
const addAccount = Effect.fn("addAccount")(function* addAccount(lane: Lane, account: NewAccount) {
	const file = yield* Effect.provideService(configFile, UserDirectories.UserDirectories, UserDirectories.make());
	const edited = yield* Effect.flatMap(textOf(file), Schema.decodeEffect(Editable));
	const lanes = yield* Effect.flatMap(Schema.decodeUnknownEffect(Lanes)(edited), realLanes);
	const placed = placedIn(lanes, lane, account);

	if (!placed.added) {
		return placed;
	}

	const entries = [...(edited[lane] ?? []), Struct.assign({ name: placed.name }, account)];
	const text = yield* Schema.encodeEffect(Editable)(Struct.assign(edited, { [lane]: entries }));

	yield* saved(file, text);

	return placed;
});

export { addAccount };

export type { NewAccount };
