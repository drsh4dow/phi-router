import { Array, Context, Effect, FileSystem, Layer, Option, Path, Record, Schema, Semaphore, Struct } from "effect";
import { Base64Url } from "effect/encoding";
import type { PlatformError } from "effect";
import { UserDirectories } from "effect/persistence";
import { writePrivately } from "./private-file.ts";

type Verdict = "sealed" | "cleared";

interface Summary {
	readonly cleared: number;
	readonly pinned: boolean;
	readonly sealed: number;
}

/**
 * One session's file: its content keys with their verdicts, the reply keys of its open-account replies, its pin and the
 * policy version the verdicts were made under. Never content, never a credential.
 */
const Stored = Schema.Struct({
	openWrote: Schema.Array(Schema.String),
	pinned: Schema.Boolean,
	policy: Schema.String,
	verdicts: Schema.Record(Schema.String, Schema.Literals(["sealed", "cleared"])),
});

type StoredFile = typeof Stored.Type;

const StoredJson = Schema.fromJsonString(Stored);

/** A failure to read or write a session's file. */
type StoreFailed = PlatformError.PlatformError | Schema.SchemaError;

/** One read of one session's store. Each field answers from that read alone. */
interface Known {
	readonly standing: (key: string) => Verdict | "unknown";
	readonly openWrote: (key: string) => boolean;
	readonly pinned: boolean;
}

type Services = FileSystem.FileSystem | Path.Path | UserDirectories.UserDirectories;

const oneWriter = 1;

const count = (stored: StoredFile): Summary => {
	const verdicts = Record.values(stored.verdicts);

	return {
		cleared: Array.countBy(verdicts, (verdict) => verdict === "cleared"),
		pinned: stored.pinned,
		sealed: Array.countBy(verdicts, (verdict) => verdict === "sealed"),
	};
};

const merged = (stored: StoredFile, found: readonly (readonly [string, Verdict])[]): StoredFile => {
	const verdicts = new Map(Record.toEntries(stored.verdicts));

	for (const [key, verdict] of found) {
		if (verdicts.get(key) !== "sealed") {
			verdicts.set(key, verdict);
		}
	}

	return Struct.assign(stored, { verdicts: Record.fromEntries(verdicts) });
};

const knownOf = (stored: StoredFile): Known => {
	const openWrote = new Set(stored.openWrote);

	return {
		openWrote: (key) => openWrote.has(key),
		pinned: stored.pinned,
		standing: (key) => Option.getOrElse(Record.get(stored.verdicts, key), () => "unknown" as const),
	};
};

const fileOf = Effect.fnUntraced(function* fileOf(session: string) {
	const directories = yield* UserDirectories.UserDirectories;
	const path = yield* Path.Path;
	const state = yield* directories.state("phi-router");

	return path.join(state, "sessions", `${Base64Url.encode(session)}.json`);
});

const storedIn = Effect.fnUntraced(function* storedIn(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const exists = yield* fs.exists(file);

	if (!exists) {
		return Option.none<StoredFile>();
	}

	const text = yield* fs.readFileString(file);
	const stored = yield* Schema.decodeEffect(StoredJson)(text);

	return Option.some(stored);
});

/**
 * The file under `policy`: empty when missing, and empty but for its pin when written under another version.
 *
 * @param {string} session The session id.
 * @param {string} policy The policy version the router runs.
 * @returns {Effect.Effect} The stored file.
 */
const current = (session: string, policy: string): Effect.Effect<StoredFile, StoreFailed, Services> =>
	Effect.map(
		Effect.flatMap(fileOf(session), storedIn),
		Option.match({
			onNone: () => ({ openWrote: [], pinned: false, policy, verdicts: {} }),
			onSome: (old) => {
				if (old.policy === policy) {
					return old;
				}

				return { openWrote: [], pinned: old.pinned, policy, verdicts: {} };
			},
		}),
	);

/** Replaces the session's file through the private writer, so a read sees one whole file. */
const replace = Effect.fnUntraced(function* replace(session: string, stored: StoredFile) {
	const file = yield* fileOf(session);
	const text = yield* Schema.encodeEffect(StoredJson)(stored);

	yield* writePrivately(file, text);
});

/**
 * One file per session under the XDG state folder, `phi-router/sessions/<id in base64url>.json`. The router process is
 * its only writer, and one lock for the process makes each read, merge and write a single step.
 */
class VerdictStore extends Context.Service<
	VerdictStore,
	{
		/** Counts the verdicts of the session's file as `read` gives it, and its pin. */
		readonly summary: (session: string, policy: string) => Effect.Effect<Summary, StoreFailed>;
		/** The session's file as it is now. A missing file, or one of another policy version, reads as empty. */
		readonly read: (session: string, policy: string) => Effect.Effect<Known, StoreFailed>;
		/**
		 * Stores a request's judgments in one step, on disk before it returns. A stored `sealed` stays `sealed`. A file of
		 * another policy version is replaced, its pin kept.
		 */
		readonly record: (
			session: string,
			policy: string,
			found: readonly (readonly [string, Verdict])[],
		) => Effect.Effect<void, StoreFailed>;
		/** Sets the session's pin through the same one-step write. Setting it twice changes nothing. */
		readonly pin: (session: string, policy: string, pinned: boolean) => Effect.Effect<void, StoreFailed>;
		/** Adds the reply keys of one completed open-account stream, through the same one-step write. */
		readonly wrote: (session: string, policy: string, keys: readonly string[]) => Effect.Effect<void, StoreFailed>;
	}
>()("phi-router/router/client/verdict-store/VerdictStore") {
	public static readonly layer = Layer.effect(
		VerdictStore,
		Effect.gen(function* make() {
			const services = yield* Effect.context<Services>();
			const writing = yield* Semaphore.make(oneWriter);

			const change = (
				session: string,
				policy: string,
				update: (now: StoredFile) => StoredFile,
			): Effect.Effect<void, StoreFailed> =>
				current(session, policy).pipe(
					Effect.flatMap((now) => replace(session, update(now))),
					Effect.uninterruptible,
					Semaphore.withPermit(writing),
					Effect.provideContext(services),
				);

			return VerdictStore.of({
				pin: (session, policy, pinned) => change(session, policy, (now) => Struct.assign(now, { pinned })),
				read: (session, policy) =>
					current(session, policy).pipe(Effect.map(knownOf), Effect.provideContext(services)),
				record: (session, policy, found) => {
					if (Array.isReadonlyArrayEmpty(found)) {
						return Effect.void;
					}

					return change(session, policy, (now) => merged(now, found));
				},
				summary: (session, policy) =>
					current(session, policy).pipe(Effect.map(count), Effect.provideContext(services)),
				wrote: (session, policy, keys) => {
					if (Array.isReadonlyArrayEmpty(keys)) {
						return Effect.void;
					}

					return change(session, policy, (now) =>
						Struct.assign(now, { openWrote: Array.dedupe([...now.openWrote, ...keys]) }),
					);
				},
			});
		}),
	).pipe(Layer.provide(UserDirectories.layer));
}

export { VerdictStore };
