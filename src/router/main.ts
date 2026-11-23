import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Listener, loopback } from "#router/client/server.ts";
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Platform, cli } from "#router/features/cli/index.ts";
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

if ("Bun" in globalThis) {
	BunRuntime.runMain(Effect.provide(cli, Layer.provideMerge(clients, bun)));
} else {
	NodeRuntime.runMain(Effect.provide(cli, Layer.provideMerge(clients, node)));
}
