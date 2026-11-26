import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import type { Option, PlatformError } from "effect";
import { Base64Url } from "effect/encoding";
import { UserDirectories } from "effect/persistence";
import { writePrivately } from "./private-file.ts";

const NoticedJson = Schema.fromJsonString(
	Schema.Struct({
		gaveUp: Schema.optionalKey(Schema.Int),
		overflowed: Schema.optionalKey(Schema.Int),
		quietUntil: Schema.optionalKey(Schema.Int),
		sealed: Schema.Int,
	}),
);

type Noticed = typeof NoticedJson.Type;

type Failed = PlatformError.PlatformError | Schema.SchemaError;

class TurnNotices extends Context.Service<
	TurnNotices,
	{
		readonly read: (session: string) => Effect.Effect<Option.Option<Noticed>, Failed>;
		readonly write: (session: string, noticed: Noticed) => Effect.Effect<void, Failed>;
	}
>()("phi-router/router/client/turn-notices/TurnNotices") {
	public static readonly layer = Layer.effect(
		TurnNotices,
		Effect.gen(function* make() {
			const directories = yield* UserDirectories.UserDirectories;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const state = yield* directories.state("phi-router");
			const fileOf = (session: string): string => path.join(state, "notices", `${Base64Url.encode(session)}.json`);

			const read = Effect.fn("TurnNotices.read")(function* read(session: string) {
				const file = fileOf(session);
				const exists = yield* fs.exists(file);

				return yield* Effect.when(
					Effect.flatMap(fs.readFileString(file), Schema.decodeEffect(NoticedJson)),
					Effect.succeed(exists),
				);
			});

			const write = Effect.fn("TurnNotices.write")(function* write(session: string, noticed: Noticed) {
				const written = yield* Schema.encodeEffect(NoticedJson)(noticed);

				yield* writePrivately(fileOf(session), written).pipe(
					Effect.provideService(FileSystem.FileSystem, fs),
					Effect.provideService(Path.Path, path),
				);
			});

			return TurnNotices.of({ read, write });
		}),
	).pipe(Layer.provide(UserDirectories.layer));
}

export { TurnNotices };

export type { Noticed };
