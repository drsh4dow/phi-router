import { Array, Context, DateTime, Effect, FileSystem, Layer, Path, Record, Schema, Semaphore, pipe } from "effect";
import type { PlatformError } from "effect";
import { UserDirectories } from "effect/persistence";
import { writePrivately } from "#router/client/private-file.ts";

/**
 * `phi-router/accounts.json` under the XDG state folder: each rate-limited account by name, with the time it is back.
 * No field can hold a credential or content.
 */
const Stored = Schema.fromJsonString(
	Schema.Struct({ rateLimited: Schema.Record(Schema.String, Schema.DateTimeUtcFromString) }),
);

type StoreFailed = PlatformError.PlatformError | Schema.SchemaError;

const stampFor = { minutes: 30 };

const oneWriter = 1;

/**
 * The 429 stamps, the one writer of `accounts.json`. Another process, such as `phi-router accounts`, reads the same file.
 */
class AccountState extends Context.Service<
	AccountState,
	{
		/** The stamps in force on `accounts`, each name to the time it is back, read from the file on each call. */
		readonly stamps: (accounts: readonly string[]) => Effect.Effect<ReadonlyMap<string, DateTime.Utc>, StoreFailed>;
		/** Stamps an account until 30 minutes from now, and drops the stamps that ran out. */
		readonly stamp: (account: string) => Effect.Effect<void, StoreFailed>;
	}
>()("phi-router/router/client/accounts/account-state/AccountState") {
	public static readonly layer = Layer.effect(
		AccountState,
		Effect.gen(function* make() {
			const directories = yield* UserDirectories.UserDirectories;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const writing = yield* Semaphore.make(oneWriter);
			const state = yield* directories.state("phi-router");
			const file = path.join(state, "accounts.json");

			const inForce = Effect.gen(function* inForce() {
				const now = yield* DateTime.now;
				const exists = yield* fs.exists(file);

				if (!exists) {
					return {};
				}

				const text = yield* fs.readFileString(file);
				const { rateLimited } = yield* Schema.decodeEffect(Stored)(text);

				return pipe(
					rateLimited,
					Record.filter((back) => DateTime.isGreaterThan(back, now)),
				);
			});

			const stamp = Effect.fn("AccountState.stamp")(function* stamp(account: string) {
				const now = yield* DateTime.now;
				const stamped = yield* inForce;
				const rateLimited = Record.set(stamped, account, DateTime.add(now, stampFor));
				const text = yield* Schema.encodeEffect(Stored)({ rateLimited });

				yield* writePrivately(file, text).pipe(
					Effect.provideService(FileSystem.FileSystem, fs),
					Effect.provideService(Path.Path, path),
				);
			}, Semaphore.withPermit(writing));

			return AccountState.of({
				stamp: (account) => Effect.uninterruptible(stamp(account)),
				stamps: (accounts) =>
					inForce.pipe(
						Effect.map(Record.filter((_back, name) => Array.contains(accounts, name))),
						Effect.map((stamped) => new Map(Record.toEntries(stamped))),
					),
			});
		}),
	).pipe(Layer.provide(UserDirectories.layer));
}

export { AccountState };
