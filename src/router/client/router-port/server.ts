import { Array, Context, Effect, Option, Record, Schema, String as Str, pipe } from "effect";
import { Callers, unnamed } from "./callers.ts";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Layer, Scope, Stream } from "effect";
import type { Caller } from "./callers.ts";
import type { HttpServerError } from "effect/http";
import { callerHeader } from "./caller-token.ts";
import { proofPath } from "./proof.ts";

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

const callerIsThisUser = Effect.gen(function* callerIsThisUser() {
	const callers = yield* Callers;
	const request = yield* HttpServerRequest.HttpServerRequest;

	const caller = Option.match(Schema.decodeUnknownOption(NodeSocket)(request.source), {
		onNone: (): Caller => unnamed,
		onSome: ({ socket }): Caller => ({
			caller: `${socket.remoteAddress}:${socket.remotePort}`,
			router: `${socket.localAddress}:${socket.localPort}`,
		}),
	});

	return yield* callers.isThisUser(caller);
});

const helloPath = "/api/hello";

const refused = HttpServerResponse.text(notThisUser, { contentType: "application/json", status: forbidden });

const tokenPresented = Effect.fnUntraced(function* tokenPresented(path: string) {
	const callers = yield* Callers;
	const request = yield* HttpServerRequest.HttpServerRequest;

	if (path === proofPath) {
		return true;
	}

	return yield* callers.tokenFine(request.headers[callerHeader] ?? "");
});

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
				const request = yield* HttpServerRequest.HttpServerRequest;
				const [path] = Str.split("?")(request.url);

				if (path === helloPath) {
					return yield* served;
				}

				if (!(yield* tokenPresented(path)) || !(yield* callerIsThisUser)) {
					return refused;
				}

				return yield* served;
			}),
	});
};

export { Listener, listensOn, serve };

export { loopback } from "#shared/cli.ts";

export type { Incoming, Outgoing, Path };
