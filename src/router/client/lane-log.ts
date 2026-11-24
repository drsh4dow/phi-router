import {
	Array,
	Context,
	DateTime,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Schema,
	String as Str,
	Struct,
	pipe,
} from "effect";
import type { PlatformError } from "effect";
import { UserDirectories } from "effect/persistence";
import { appendPrivately } from "./private-file.ts";

/**
 * Why a request ran on its lane: no sealed new content, sealed new content, the session's pin, a BAA repo, Codex's
 * thread-title request, a move to another account than its first, or the router unable to build a clean body.
 */
const Reasons = Schema.Literals([
	"clean",
	"sealed new content",
	"pinned",
	"BAA repo",
	"title",
	"failover",
	"router failure",
]);

type Reason = typeof Reasons.Type;

const Line = Schema.Struct({
	account: Schema.String,
	judgeCost: Schema.Finite,
	judgeFailures: Schema.Int,
	lane: Schema.Literals(["clean", "sealed"]),
	model: Schema.String,
	reason: Reasons,
	session: Schema.String,
	substitute: Schema.Boolean,
	time: Schema.String,
});

const LineJson = Schema.fromJsonString(Line);

/** What a route knows of its request. The log adds the time. */
type Routed = Omit<typeof Line.Type, "time">;

type Last = Pick<Routed, "account" | "model" | "substitute">;

const decodeLine = Schema.decodeUnknownOption(LineJson);

class LaneLog extends Context.Service<
	LaneLog,
	{
		/**
		 * Opens the log for one request, and fails when the log cannot be opened for appending, so the route calls it
		 * before the first send. What it returns appends the request's one line, which the route writes once its walk
		 * across its accounts ends.
		 */
		readonly opened: (
			session: string,
		) => Effect.Effect<
			(line: Omit<Routed, "session">) => Effect.Effect<void, PlatformError.PlatformError | Schema.SchemaError>,
			PlatformError.PlatformError
		>;
		/** The session's last line. A line a crash cut short is skipped. */
		readonly last: (session: string) => Effect.Effect<Option.Option<Last>, PlatformError.PlatformError>;
	}
>()("phi-router/router/client/lane-log/LaneLog") {
	public static readonly layer = Layer.effect(
		LaneLog,
		Effect.gen(function* make() {
			const directories = yield* UserDirectories.UserDirectories;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const state = yield* directories.state("phi-router");
			const file = path.join(state, "lanes.jsonl");

			const appended = (text: string): Effect.Effect<void, PlatformError.PlatformError> =>
				appendPrivately(file, text).pipe(
					Effect.provideService(FileSystem.FileSystem, fs),
					Effect.provideService(Path.Path, path),
				);

			const append = Effect.fn("LaneLog.append")(function* append(routed: Routed) {
				const now = yield* DateTime.now;
				const line = yield* Schema.encodeEffect(LineJson)(Struct.assign({ time: DateTime.formatIso(now) }, routed));

				yield* appended(`${line}\n`);
			});

			const opened = Effect.fn("LaneLog.opened")(function* opened(session: string) {
				yield* appended("");

				return (line: Omit<Routed, "session">): ReturnType<typeof append> =>
					append(Struct.assign(line, { session }));
			});

			const last = Effect.fn("LaneLog.last")(function* last(session: string) {
				const exists = yield* fs.exists(file);

				if (!exists) {
					return Option.none();
				}

				const text = yield* fs.readFileString(file);

				return pipe(
					Str.split(text, "\n"),
					Array.map((line) => decodeLine(line)),
					Array.getSomes,
					Array.findLast((line) => line.session === session),
					Option.map(Struct.pick(["account", "model", "substitute"])),
				);
			});

			return LaneLog.of({ last, opened });
		}),
	).pipe(Layer.provide(UserDirectories.layer));
}

export { LaneLog, Reasons };

export type { Reason, Routed };
