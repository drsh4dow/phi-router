import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Pid } from "#shared/cli.ts";
import type { PlatformError } from "effect";
import { Started } from "./processes.ts";
import { UserDirectories } from "effect/persistence";
import { writePrivately } from "./private-file.ts";

/**
 * An instance's registration: its pid, that process's start time, and the session id and working folder `start` gave.
 * It holds while a process with the pid runs, is no zombie, and has the start time.
 */
const Lease = Schema.Struct({ folder: Schema.String, pid: Pid, session: Schema.NonEmptyString, started: Started });

/** `phi-router/leases.json` under the XDG state folder. Never content, never a credential. */
const StoredJson = Schema.fromJsonString(Schema.Struct({ leases: Schema.Array(Lease) }));

/** A failure to read or write the lease registry. */
type RegistryFailed = PlatformError.PlatformError | Schema.SchemaError;

/**
 * The lease registry, one file the router writes and a launched router adopts. The router's lifecycle is its only
 * writer, so the registry holds no lock of its own.
 */
class LeaseRegistry extends Context.Service<
	LeaseRegistry,
	{
		/** The stored leases. A missing file reads as none. */
		readonly adopted: Effect.Effect<readonly (typeof Lease.Type)[], RegistryFailed>;
		/** Replaces the file with a temp file, its sync and a rename, so it is on disk and whole before this returns. */
		readonly store: (leases: readonly (typeof Lease.Type)[]) => Effect.Effect<void, RegistryFailed>;
	}
>()("phi-router/router/client/leases/LeaseRegistry") {
	public static readonly layer = Layer.effect(
		LeaseRegistry,
		Effect.gen(function* make() {
			const directories = yield* UserDirectories.UserDirectories;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const state = yield* directories.state("phi-router");
			const file = path.join(state, "leases.json");

			const adopted = Effect.gen(function* adopted() {
				const exists = yield* fs.exists(file);

				if (!exists) {
					return [];
				}

				const stored = yield* fs.readFileString(file).pipe(Effect.flatMap(Schema.decodeEffect(StoredJson)));

				return stored.leases;
			});

			const store = (leases: readonly (typeof Lease.Type)[]): Effect.Effect<void, RegistryFailed> =>
				Schema.encodeEffect(StoredJson)({ leases }).pipe(
					Effect.flatMap((text) => writePrivately(file, text)),
					Effect.provideService(FileSystem.FileSystem, fs),
					Effect.provideService(Path.Path, path),
				);

			return LeaseRegistry.of({ adopted, store });
		}),
	).pipe(Layer.provide(UserDirectories.layer));
}

export { Lease, LeaseRegistry };

export type { RegistryFailed };
