import { Array, Context, Effect, Option, Record, Schema, pipe } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Layer, Scope, Stream } from "effect";
import { Callers } from "./callers.ts";
import type { HttpServerError } from "effect/http";

const badRequest = 400;

const forbidden = 403;

const notThisUser =
	'{"type":"error","error":{"type":"permission_error","message":"phi-router answers only the user who runs it"}}';

const NodeSocket = Schema.Struct({
	socket: Schema.Struct({
		localAddress: Schema.String,
		localPort: Schema.Int,
		remoteAddress: Schema.String,
		remotePort: Schema.Int,
	}),
});

interface Incoming {
	readonly headers: Readonly<Record<string, string | undefined>>;
	readonly query: Readonly<Record<string, string | undefined>>;
	readonly body: string;
}

type Outgoing =
	| { readonly kind: "whole"; readonly status: number; readonly body: string }
	| {
			readonly kind: "relayed";
			readonly status: number;
			readonly headers: Readonly<Record<string, string>>;
			readonly body: Stream.Stream<Uint8Array, unknown>;
	  };

interface Path {
	readonly method: "GET" | "POST";
	readonly path: `/${string}`;
	readonly answer: (incoming: Incoming) => Effect.Effect<Outgoing, never, Scope.Scope>;
}

class Listener extends Context.Service<
	Listener,
	{ readonly on: (port: number) => Layer.Layer<HttpServer.HttpServer, HttpServerError.ServeError> }
>()("phi-router/router/client/router-port/server/Listener") {}

const listensOn = Effect.gen(function* listensOn() {
	const server = yield* HttpServer.HttpServer;

	return HttpServer.formatAddress(server.address);
});

const handlerOf = ({
	answer,
}: Path): Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	never,
	HttpServerRequest.HttpServerRequest | Scope.Scope
> =>
	Effect.gen(function* handler() {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const body = yield* request.text;

		const query = Option.match(HttpServerRequest.toURL(request), {
			onNone: () => ({}),
			onSome: (url) => Record.fromEntries(url.searchParams),
		});

		const outgoing = yield* answer({ body, headers: request.headers, query });

		if (outgoing.kind === "whole") {
			return HttpServerResponse.text(outgoing.body, { contentType: "application/json", status: outgoing.status });
		}

		return HttpServerResponse.stream(outgoing.body, { headers: outgoing.headers, status: outgoing.status });
	}).pipe(Effect.catchTag("HttpServerError", () => Effect.succeed(HttpServerResponse.empty({ status: badRequest }))));

/**
 * Whether the request's caller is the user the router runs as (ADR 0006). A request whose socket names no ends is not.
 */
const callerIsThisUser = Effect.gen(function* callerIsThisUser() {
	const callers = yield* Callers;
	const request = yield* HttpServerRequest.HttpServerRequest;

	return yield* Option.match(Schema.decodeUnknownOption(NodeSocket)(request.source), {
		onNone: () => Effect.succeed(false),
		onSome: ({ socket }) =>
			callers.isThisUser({
				caller: `${socket.remoteAddress}:${socket.remotePort}`,
				router: `${socket.localAddress}:${socket.localPort}`,
			}),
	});
});

/** A request from another user answers 403 before its body is read. */
const serve = (paths: readonly Path[]): Layer.Layer<never, never, HttpServer.HttpServer | Callers> => {
	const routes = pipe(
		paths,
		Array.map((row) => HttpRouter.route(row.method, row.path, handlerOf(row))),
	);

	return HttpRouter.serve(HttpRouter.addAll(routes), {
		disableListenLog: true,
		disableLogger: true,
		middleware: (served) =>
			Effect.gen(function* onlyThisUser() {
				if (!(yield* callerIsThisUser)) {
					return HttpServerResponse.text(notThisUser, { contentType: "application/json", status: forbidden });
				}

				return yield* served;
			}),
	});
};

export { Listener, listensOn, serve };

export { loopback } from "#shared/cli.ts";

export type { Incoming, Outgoing, Path };
