import { Context, Effect, FileSystem, Layer, Option, Path, Schema, pipe } from "effect";
import { Base64Url } from "effect/encoding";
import type { PlatformError } from "effect";
import { UserDirectories } from "effect/persistence";
import { writePrivately } from "./private-file.ts";

const SealedAtLastNoticeJson = Schema.fromJsonString(Schema.Struct({ sealed: Schema.Int }));

/**
 * One file per session under the XDG state folder, `phi-router/notices/<id in base64url>.json`, which holds the sealed
 * count the session's last turn end saw, so the next one announces only what its own turn sealed. A harness hook runs
 * once per turn, so the count lives on disk between them. It holds no content.
 */
class SealNotices extends Context.Service<
	SealNotices,
	{
		/** Stores `sealed` as the session's count and returns the count stored before, none for a session it never saw. */
		readonly swap: (
			session: string,
			sealed: number,
		) => Effect.Effect<Option.Option<number>, PlatformError.PlatformError | Schema.SchemaError>;
	}
>()("phi-router/router/client/seal-notices/SealNotices") {
	public static readonly layer = Layer.effect(
		SealNotices,
		Effect.gen(function* make() {
			const directories = yield* UserDirectories.UserDirectories;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const state = yield* directories.state("phi-router");

			const swap = Effect.fn("SealNotices.swap")(function* swap(session: string, sealed: number) {
				const file = path.join(state, "notices", `${Base64Url.encode(session)}.json`);
				const exists = yield* fs.exists(file);

				const before = yield* Effect.when(
					Effect.flatMap(fs.readFileString(file), Schema.decodeEffect(SealedAtLastNoticeJson)),
					Effect.succeed(exists),
				);

				const written = yield* Schema.encodeEffect(SealedAtLastNoticeJson)({ sealed });

				yield* writePrivately(file, written).pipe(
					Effect.provideService(FileSystem.FileSystem, fs),
					Effect.provideService(Path.Path, path),
				);

				return pipe(
					before,
					Option.map((seen) => seen.sealed),
				);
			});

			return SealNotices.of({ swap });
		}),
	).pipe(Layer.provide(UserDirectories.layer));
}

export { SealNotices };
