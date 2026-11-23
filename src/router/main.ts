import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Runtime, Schema } from "effect";
import { Listener, loopback } from "#router/client/server.ts";
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Platform, cli, noBaaKeyExit } from "#router/features/cli/index.ts";
import { LeaseRegistry } from "#router/client/leases.ts";
import { LeaseRequests } from "#router/client/lease-request.ts";
import { Processes } from "#router/client/processes.ts";
import { VerdictStore } from "#router/client/verdict-store.ts";
import { createServer } from "node:http";

/**
 * Node's server on both runtimes, since only its request carries the caller's port (ADR 0006). Building a `Listener`
 * binds nothing: only `serve` asks it for a server, so the bare command and `status` start as before, with no
 * configuration file.
 */
const listener = Layer.succeed(
	Listener,
	Listener.of({ on: (port) => NodeHttpServer.layer(createServer, { host: loopback, port }) }),
);

const platform = (name: Platform["Service"]["name"]): Layer.Layer<Platform> =>
	Layer.succeed(Platform, Platform.of({ entry: import.meta.filename, name }));

/** Each platform also names this file, so `start` can launch `serve` on the same runtime. */
const bun = Layer.merge(BunServices.layer, platform("bun"));

const node = Layer.merge(NodeServices.layer, platform("node"));

const clients = Layer.mergeAll(VerdictStore.layer, LeaseRegistry.layer, LeaseRequests.layer, Processes.layer, listener);

/** A failure whose line is printed already, so the runtime logs nothing more and exits with `code`. */
class Told extends Schema.TaggedError<Told, { readonly brand: unique symbol }>()("Told", { code: Schema.Int }) {
	public override readonly [Runtime.errorReported] = false;

	public override get [Runtime.errorExitCode](): number {
		return this.code;
	}
}

/** How a command exits that failed for any other reason than a missing BAA key. */
const failedExit = 1;

const told = (line: string, code: number): Effect.Effect<never, Told> =>
	Effect.andThen(Console.error(line), Effect.fail(Told.make({ code })));

/**
 * The commands, with the two failures a hook or pi passes on to the developer printed as their line alone on stderr: a
 * lease `start` could not leave, and a `serve` with no BAA key, which exits with the code its `start` reads.
 */
const program = Effect.catchTags(cli, {
	NoBaaKey: ({ message }) => told(message, noBaaKeyExit),
	StartFailed: ({ message }) => told(message, failedExit),
});

if ("Bun" in globalThis) {
	BunRuntime.runMain(Effect.provide(program, Layer.provideMerge(clients, bun)));
} else {
	NodeRuntime.runMain(Effect.provide(program, Layer.provideMerge(clients, node)));
}
