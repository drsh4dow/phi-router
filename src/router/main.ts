import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Runtime, Schema } from "effect";
import { Listener, loopback } from "#router/client/router-port/index.ts";
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Platform, cli, noBaaKeyExit, rewriteExit } from "#router/features/cli/index.ts";
import { clients } from "#router/client/clients.ts";
import { createServer } from "node:http";

const listener = Layer.succeed(
	Listener,
	Listener.of({ on: (port) => NodeHttpServer.layer(createServer, { host: loopback, port }) }),
);

const platform = (name: Platform["Service"]["name"]): Layer.Layer<Platform> =>
	Layer.succeed(Platform, Platform.of({ entry: import.meta.filename, name, os: globalThis.process.platform }));

const bun = Layer.merge(BunServices.layer, platform("bun"));

const node = Layer.merge(NodeServices.layer, platform("node"));

const clientsWithListener = Layer.merge(clients, listener);

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
	RewriteAsked: ({ reason }) => told(reason, rewriteExit),
	StartFailed: ({ message }) => told(message, startFailedExit),
});

if ("Bun" in globalThis) {
	BunRuntime.runMain(Effect.provide(program, Layer.provideMerge(clientsWithListener, bun)));
} else {
	NodeRuntime.runMain(Effect.provide(program, Layer.provideMerge(clientsWithListener, node)));
}
