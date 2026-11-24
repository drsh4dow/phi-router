import { Array, Effect, FileSystem, Option, Predicate, Schema, Struct, pipe } from "effect";
import type { Lane, Vendor } from "./configuration/index.ts";
import { LaneFile, configFile } from "./configuration/index.ts";
import { UserDirectories } from "effect/persistence";
import { realFolder } from "./processes.ts";
import { writePrivately } from "./private-file.ts";

type NewAccount =
	| { readonly vendor: Vendor; readonly loginFolder: string }
	| { readonly vendor: Vendor; readonly keyCommand: string; readonly scheme: "apiKey" | "oauth" }
	| { readonly vendor: Vendor; readonly forwarded: true }
	| { readonly vendor: Vendor; readonly keyFile: string; readonly scheme: "apiKey" };

interface Wanted {
	readonly lane: Lane;
	readonly account: NewAccount;
}

interface Additions {
	readonly accounts: Array.NonEmptyReadonlyArray<Wanted>;
}

interface Placed {
	readonly name: string;
	readonly isNew: boolean;
	readonly vendorAccountBefore: Option.Option<string>;
	readonly lane: Lane;
}

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

const saved = Effect.fnUntraced(function* saved(file: string, text: string) {
	yield* Schema.decodeEffect(LaneFile)(text);
	yield* writePrivately(file, `${text}\n`);
});

const atRealPath = Effect.fnUntraced(function* atRealPath(entry: Entry) {
	if (Predicate.isUndefined(entry.loginFolder)) {
		return entry;
	}

	const loginFolder = yield* realFolder(entry.loginFolder);

	return Struct.assign(entry, { loginFolder });
});

const realLanes = Effect.fnUntraced(function* realLanes(lanes: typeof Lanes.Type) {
	const clean = yield* Effect.forEach(lanes.clean ?? [], atRealPath, { concurrency: 1 });
	const sealed = yield* Effect.forEach(lanes.sealed ?? [], atRealPath, { concurrency: 1 });

	return { clean, sealed };
});

const bothLanes: readonly Lane[] = ["clean", "sealed"];

const placedIn = (lanes: Editing["lanesAtRealPaths"], lane: Lane, account: NewAccount): Placed => {
	const listed = lanes[lane] ?? [];

	const same = pipe(
		bothLanes,
		Array.findFirst((on) =>
			pipe(
				lanes[on] ?? [],
				Array.findFirst((entry) => sameSource(entry, account)),
				Option.map((entry): Placed => ({
					isNew: false,
					lane: on,
					name: entry.name,
					vendorAccountBefore: Option.none(),
				})),
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

	const vendorAccountBefore = pipe(
		listed,
		Array.findLast((entry) => entry.vendor === account.vendor),
		Option.map((entry) => entry.name),
	);

	return { isNew: true, lane, name: freeName(wordOf(account), names), vendorAccountBefore };
};

interface Editing {
	readonly asWritten: typeof Editable.Type;
	readonly lanesAtRealPaths: Readonly<Partial<Record<Lane, readonly Entry[]>>>;
}

const addAccounts = Effect.fn("addAccounts")(function* addAccounts(additions: Additions) {
	const file = yield* Effect.provideService(configFile, UserDirectories.UserDirectories, UserDirectories.make());
	const read = yield* Effect.flatMap(textOf(file), Schema.decodeEffect(Editable));
	const lanes = yield* Effect.flatMap(Schema.decodeUnknownEffect(Lanes)(read), realLanes);

	const [edited, placed] = pipe(
		additions.accounts,
		Array.mapAccum(
			{ asWritten: read, lanesAtRealPaths: lanes },
			(editing, { account, lane }): readonly [Editing, Placed] => {
				const place = placedIn(editing.lanesAtRealPaths, lane, account);

				if (!place.isNew) {
					return [editing, place];
				}

				const entry = Struct.assign({ name: place.name }, account);

				const next = {
					asWritten: Struct.assign(editing.asWritten, { [lane]: [...(editing.asWritten[lane] ?? []), entry] }),
					lanesAtRealPaths: Struct.assign(editing.lanesAtRealPaths, {
						[lane]: [...(editing.lanesAtRealPaths[lane] ?? []), entry],
					}),
				};

				return [next, place];
			},
		),
	);

	const anyAdded = pipe(
		placed,
		Array.some(({ isNew }) => isNew),
	);

	if (anyAdded) {
		yield* Effect.flatMap(Schema.encodeEffect(Editable)(edited.asWritten), (text) => saved(file, text));
	}

	return placed;
});

export { addAccounts };

export type { NewAccount };
