import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { Pid } from "#shared/cli.ts";
import type { PlatformError } from "effect";
import { Started } from "./processes.ts";
import { UserDirectories } from "effect/persistence";
import { writePrivately } from "./private-file.ts";

const Lease = Schema.Struct({ folder: Schema.String, pid: Pid, session: Schema.NonEmptyString, started: Started });

const StoredJson = Schema.fromJsonString(Schema.Struct({ leases: Schema.Array(Lease) }));

type RegistryFailed = PlatformError.PlatformError | Schema.SchemaError;

class LeaseRegistry extends Context.Service<
	LeaseRegistry,
	{
		readonly adopted: Effect.Effect<readonly (typeof Lease.Type)[], RegistryFailed>;
		readonly store: (leases: readonly (typeof Lease.Type)[]) => Effect.Effect<void, RegistryFailed>;
	}
>()("phi-router/router/client/leases/LeaseRegistry") {
	public static readonly layer = Layer.effect(
		LeaseRegistry,
		Effect.gen(function* make() {
			const directories = yield* UserDirectories.UserDirectories;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
					Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
				);

			return LeaseRegistry.of({ adopted, store });
		}),
	).pipe(Layer.provide(UserDirectories.layer));
}

export { Lease, LeaseRegistry };

export type { RegistryFailed };
