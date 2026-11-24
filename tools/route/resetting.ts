import { Context, Effect, Latch, Layer } from "effect";
import { HttpServer, HttpServerRequest } from "effect/http";
import { NodeHttpServer, NodeHttpServerRequest } from "@effect/platform-node";

const reset = Effect.gen(function* reset() {
	const request = yield* HttpServerRequest.HttpServerRequest;
	const { socket } = NodeHttpServerRequest.toIncomingMessage(request);

	socket.destroy();

	return yield* Effect.never;
});

const loopback = Effect.map(Layer.build(NodeHttpServer.layerTest), Context.get(HttpServer.HttpServer));

const resetting = Effect.gen(function* resetting() {
	const server = yield* loopback;

	yield* server.serve(Effect.interruptible(reset));

	return { endpoint: HttpServer.formatAddress(server.address) };
});

const silent = Effect.gen(function* silent() {
	const server = yield* loopback;
	const arrived = yield* Latch.make();

	yield* server.serve(Effect.interruptible(Effect.andThen(arrived.open, Effect.never)));

	return { arrived, endpoint: HttpServer.formatAddress(server.address) };
});

export { resetting, silent };
