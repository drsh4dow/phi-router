import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Runtime, Schema } from "effect";
import { LeaseRequests, Listener, loopback } from "#router/client/router-port/index.ts";
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Platform, cli, noBaaKeyExit } from "#router/features/cli/index.ts";
import { LeaseRegistry } from "#router/client/leases.ts";
import { Processes } from "#router/client/processes.ts";
import { VerdictStore } from "#router/client/verdict-store.ts";
import { createServer } from "node:http";

const listener = Layer.succeed(
	Listener,
	Listener.of({ on: (port) => NodeHttpServer.layer(createServer, { host: loopback, port }) }),
);

const platform = (name: Platform["Service"]["name"]): Layer.Layer<Platform> =>
	Layer.succeed(Platform, Platform.of({ entry: import.meta.filename, name }));

const bun = Layer.merge(BunServices.layer, platform("bun"));

const node = Layer.merge(NodeServices.layer, platform("node"));

const clients = Layer.mergeAll(VerdictStore.layer, LeaseRegistry.layer, LeaseRequests.layer, Processes.layer, listener);

class Told extends Schema.TaggedError<Told, { readonly brand: unique symbol }>()("Told", { code: Schema.Int }) {
	public override readonly [Runtime.errorReported] = false;

	public override get [Runtime.errorExitCode](): number {
		return this.code;
	}
}

const startFailedExit = 1;

const told = (line: string, code: number): Effect.Effect<never, Told> =>
	Effect.andThen(Console.error(line), Effect.fail(Told.make({ code })));

const program = Effect.catchTags(cli, {
	NoBaaKey: ({ message }) => told(message, noBaaKeyExit),
	StartFailed: ({ message }) => told(message, startFailedExit),
});

if ("Bun" in globalThis) {
	BunRuntime.runMain(Effect.provide(program, Layer.provideMerge(clients, bun)));
} else {
	NodeRuntime.runMain(Effect.provide(program, Layer.provideMerge(clients, node)));
}
