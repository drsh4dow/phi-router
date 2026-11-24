import { Context, Effect, Layer, Schema, Struct } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import { Pid } from "#shared/cli.ts";
import { loopback } from "./server.ts";
import { realFolder } from "#router/client/processes.ts";

/** What `start` sends the router. The router adds the start time. */
const LeaseRequest = Schema.Struct({ folder: Schema.String, pid: Pid, session: Schema.NonEmptyString });

const LeaseRequestJson = Schema.fromJsonString(LeaseRequest);

/** The lease row of the router's path table. */
const leasePath = "/phi-router/leases";

/** What the router says to a lease request it could read. */
type Reply = "accepted" | "ended" | "closing" | "unread";

const statusOf = { accepted: 200, closing: 503, ended: 409, unread: 503 } as const satisfies Record<Reply, number>;

/**
 * What `start` learns. `unanswered`: no connection, so no router listens. `waiting`: a router that is starting up,
 * closing or could not read the processes, or any other answer.
 */
type Answered = "accepted" | "ended" | "unanswered" | "waiting";

const answeredTo = (status: number): Answered => {
	if (status === statusOf.accepted) {
		return "accepted";
	}

	if (status === statusOf.ended) {
		return "ended";
	}

	return "waiting";
};

/**
 * Asks the router on a loopback port to take a lease. The folder goes as its real absolute path, so the router's BAA
 * repo check reads one spelling whatever folder the router runs in.
 */
class LeaseRequests extends Context.Service<
	LeaseRequests,
	{ readonly post: (port: number, request: typeof LeaseRequest.Type) => Effect.Effect<Answered> }
>()("phi-router/router/client/router-port/lease-request/LeaseRequests") {
	public static readonly layer = Layer.effect(
		LeaseRequests,
		Effect.gen(function* make() {
			const client = yield* HttpClient.HttpClient;
			const spawner = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();

			const post = (port: number, request: typeof LeaseRequest.Type): Effect.Effect<Answered> =>
				Effect.gen(function* posted() {
					const folder = yield* Effect.provideContext(realFolder(request.folder), spawner);

					const body = yield* Effect.orDie(
						Schema.encodeEffect(LeaseRequestJson)(Struct.assign(request, { folder })),
					);

					const sent = HttpClientRequest.post(`http://${loopback}:${String(port)}${leasePath}`).pipe(
						HttpClientRequest.bodyText(body, "application/json"),
					);

					return yield* client.execute(sent).pipe(
						Effect.match({
							onFailure: (): Answered => "unanswered",
							onSuccess: ({ status }) => answeredTo(status),
						}),
					);
				}).pipe(Effect.scoped, Effect.provideService(HttpClient.TracerPropagationEnabled, false));

			return LeaseRequests.of({ post });
		}),
	).pipe(Layer.provide(FetchHttpClient.layer));
}

export { LeaseRequest, LeaseRequestJson, LeaseRequests, leasePath, statusOf };

export type { Answered, Reply };
