import {
	Array,
	Context,
	Effect,
	FileSystem,
	Layer,
	Number as Num,
	Option,
	Path,
	Record,
	Schema,
	Semaphore,
	Struct,
	pipe,
} from "effect";
import { Handle, handleAt } from "#router/primitives/handle.ts";
import { folderPrivately, writePrivately } from "./private-file.ts";
import { Base64Url } from "effect/encoding";
import type { ChildProcessSpawner } from "effect/process";
import { Count } from "#shared/cli.ts";
import type { Pinned } from "#shared/cli.ts";
import type { PlatformError } from "effect";
import { UserDirectories } from "effect/persistence";

const none = 0;

const SealedPart = Schema.Struct({ images: Count, key: Schema.String, text: Schema.String });

const PinnedRun = Schema.Struct({
	cleared: Schema.optionalKey(Schema.String),
	gaveUp: Count,
	inARow: Count,
	rewrites: Count,
	withheld: Schema.optionalKey(Schema.String),
});

const Stored = Schema.Struct({
	answers: Schema.Record(Schema.String, PinnedRun),
	parts: Schema.Array(SealedPart),
});

const StoredJson = Schema.fromJsonString(Stored);

type Part = typeof SealedPart.Type;

type Run = typeof PinnedRun.Type;

type StoredFile = typeof Stored.Type;

type StoreFailed = PlatformError.PlatformError | Schema.SchemaError;

type Services =
	| ChildProcessSpawner.ChildProcessSpawner
	| FileSystem.FileSystem
	| Path.Path
	| UserDirectories.UserDirectories;

interface Sealed {
	readonly partOf: (handle: typeof Handle.Type) => Option.Option<Part>;
}

const empty: StoredFile = { answers: {}, parts: [] };

const unrun: Run = { gaveUp: none, inARow: none, rewrites: none };

const firstSequence = 1;

const oneWriter = 1;

const handlesOf = (stored: StoredFile): ReadonlyMap<string, typeof Handle.Type> =>
	new Map(
		pipe(
			stored.parts,
			Array.map(({ key }, index) => [key, handleAt(index + firstSequence)] as const),
		),
	);

const kept = (stored: StoredFile, parts: readonly Part[]): StoredFile => {
	const known = new Set(
		pipe(
			stored.parts,
			Array.map(({ key }) => key),
		),
	);

	const added = pipe(
		parts,
		Array.filter(({ key }) => !known.has(key)),
		Array.dedupeWith((one, other) => one.key === other.key),
	);

	return Struct.assign(stored, { parts: [...stored.parts, ...added] });
};

type ReplyOf = (handle: typeof Handle.Type) => string;

const summaryOf = (stored: StoredFile, replyOf: ReplyOf): typeof Pinned.Type => {
	const runs = Record.values(stored.answers);

	const entries = Record.toEntries(stored.answers);

	return {
		cleared: pipe(
			entries,
			Array.flatMap(([subagent, { cleared }]) =>
				Option.match(Option.fromUndefinedOr(cleared), { onNone: () => [], onSome: (key) => [{ key, subagent }] }),
			),
		),
		gaveUp: pipe(
			runs,
			Array.map(({ gaveUp }) => gaveUp),
			Num.sumAll,
		),
		rewrites: pipe(
			runs,
			Array.map(({ rewrites }) => rewrites),
			Num.sumAll,
		),
		runs: runs.length,
		withheld: pipe(
			entries,
			Array.flatMap(([subagent, { withheld }]) =>
				Option.match(Option.flatMap(Option.fromUndefinedOr(withheld), Schema.decodeOption(Handle)), {
					onNone: () => [],
					onSome: (handle) => [{ reply: replyOf(handle), subagent }],
				}),
			),
		),
	};
};

const sessionsFolder = Effect.fnUntraced(function* sessionsFolder(folder: "files" | "sessions") {
	const directories = yield* UserDirectories.UserDirectories;
	const path = yield* Path.Path;
	const state = yield* directories.state("phi-router");

	return path.join(state, folder);
});

const fileOf = Effect.fnUntraced(function* fileOf(session: string) {
	const path = yield* Path.Path;
	const folder = yield* sessionsFolder("sessions");

	return path.join(folder, `${Base64Url.encode(session)}.sealed.json`);
});

const current = Effect.fnUntraced(function* current(session: string) {
	const fs = yield* FileSystem.FileSystem;
	const file = yield* fileOf(session);
	const exists = yield* fs.exists(file);

	if (!exists) {
		return empty;
	}

	const text = yield* fs.readFileString(file);

	return yield* Schema.decodeEffect(StoredJson)(text);
});

const replace = Effect.fnUntraced(function* replace(session: string, stored: StoredFile) {
	const file = yield* fileOf(session);
	const text = yield* Schema.encodeEffect(StoredJson)(stored);

	yield* writePrivately(file, text);
});

const filesFolderOf = Effect.fnUntraced(function* filesFolderOf(session: string) {
	const path = yield* Path.Path;
	const files = yield* sessionsFolder("files");
	const folder = path.join(files, Base64Url.encode(session));

	yield* folderPrivately(folder);

	return folder;
});

class SealedStore extends Context.Service<
	SealedStore,
	{
		readonly keep: (
			session: string,
			parts: readonly Part[],
		) => Effect.Effect<ReadonlyMap<string, typeof Handle.Type>, StoreFailed>;
		readonly read: (session: string) => Effect.Effect<Sealed, StoreFailed>;
		readonly answered: (
			session: string,
			subagent: string,
			update: (now: Run) => Run,
		) => Effect.Effect<Run, StoreFailed>;
		readonly summary: (session: string, replyOf: ReplyOf) => Effect.Effect<typeof Pinned.Type, StoreFailed>;
		readonly filesFolder: (session: string) => Effect.Effect<string, PlatformError.PlatformError>;
	}
>()("phi-router/router/client/sealed-store/SealedStore") {
	public static readonly layer = Layer.effect(
		SealedStore,
		Effect.gen(function* make() {
			const services = yield* Effect.context<Services>();
			const writing = yield* Semaphore.make(oneWriter);

			const changed = <Result>(
				session: string,
				change: (now: StoredFile) => readonly [Result, StoredFile],
			): Effect.Effect<Result, StoreFailed> =>
				current(session).pipe(
					Effect.flatMap((now) => {
						const [result, next] = change(now);

						if (next === now) {
							return Effect.succeed(result);
						}

						return Effect.as(replace(session, next), result);
					}),
					Effect.uninterruptible,
					Semaphore.withPermit(writing),
					Effect.provideContext(services),
				);

			return SealedStore.of({
				answered: (session, subagent, update) =>
					changed(session, (now) => {
						const run = update(Option.getOrElse(Record.get(now.answers, subagent), () => unrun));

						return [run, Struct.assign(now, { answers: Record.set(now.answers, subagent, run) })] as const;
					}),
				filesFolder: (session) => Effect.provideContext(filesFolderOf(session), services),
				keep: (session, parts) =>
					changed(session, (now) => {
						const next = kept(now, parts);

						if (next.parts.length === now.parts.length) {
							return [handlesOf(now), now] as const;
						}

						return [handlesOf(next), next] as const;
					}),
				read: (session) =>
					current(session).pipe(
						Effect.map((stored): Sealed => ({
							partOf: (handle) =>
								Array.findFirst(stored.parts, (_part, index) => handleAt(index + firstSequence) === handle),
						})),
						Effect.provideContext(services),
					),
				summary: (session, replyOf) =>
					current(session).pipe(
						Effect.map((stored) => summaryOf(stored, replyOf)),
						Effect.provideContext(services),
					),
			});
		}),
	).pipe(Layer.provide(UserDirectories.layer));
}

export { SealedStore };

export type { Run as PinnedRun, Part as SealedPart, StoreFailed };
