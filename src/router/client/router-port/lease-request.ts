import { Context, Effect, Layer, Schema, Struct } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { Pid, loopback } from "#shared/cli.ts";
import type { ChildProcessSpawner } from "effect/process";
import { Proofs } from "./proof.ts";
import { realFolder } from "#router/client/processes.ts";

const LeaseRequest = Schema.Struct({ folder: Schema.String, pid: Pid, session: Schema.NonEmptyString });

const LeaseRequestJson = Schema.fromJsonString(LeaseRequest);

const leasePath = "/phi-router/leases";

type LeaseReply = "accepted" | "ended" | "closing" | "unread";

const statusOf = { accepted: 200, closing: 503, ended: 409, unread: 503 } as const satisfies Record<LeaseReply, number>;

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

class LeaseRequests extends Context.Service<
	LeaseRequests,
	{ readonly post: (port: number, request: typeof LeaseRequest.Type) => Effect.Effect<Answered> }
>()("phi-router/router/client/router-port/lease-request/LeaseRequests") {
	public static readonly layer = Layer.effect(
		LeaseRequests,
		Effect.gen(function* make() {
			const client = yield* HttpClient.HttpClient;
			const proofs = yield* Proofs;
			const spawner = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();

			const post = (port: number, request: typeof LeaseRequest.Type): Effect.Effect<Answered> =>
				Effect.gen(function* posted() {
					const folder = yield* Effect.provideContext(realFolder(request.folder), spawner);

					const body = yield* Effect.orDie(
						Schema.encodeEffect(LeaseRequestJson)(Struct.assign(request, { folder })),
					);

					const headers = yield* proofs.callerHeaders(port);

					const sent = HttpClientRequest.post(`http://${loopback}:${String(port)}${leasePath}`).pipe(
						HttpClientRequest.setHeaders(headers),
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
	).pipe(Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Proofs.layer)));
}

export { LeaseRequest, LeaseRequestJson, LeaseRequests, leasePath, statusOf };

export type { Answered, LeaseReply };
