import { Context, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { Status } from "#shared/cli.ts";
import { StatusJson } from "#shared/cli.ts";
import { loopback } from "./server.ts";

const PinRequest = Schema.Struct({ pinned: Schema.Boolean, session: Schema.NonEmptyString });

const PinRequestJson = Schema.fromJsonString(PinRequest);

/** The pin row and the status row of the router's path table. `status` names its session in the query. */
const sessionPaths = { pin: "/phi-router/pin", status: "/phi-router/status" } as const;

const ok = 200;

/** Why the router on a port gave no usable answer: nothing answered, or what it answered. */
interface Unanswered {
	readonly reason: string;
}

const unanswered = (reason: string): Unanswered => ({ reason });

const noRouter = unanswered("no router answers there");

/** How long a command waits for the router's answer, inside the 10 seconds Claude Code and Codex give a hook. */
const patience = "5 seconds";

const stalled = unanswered("it took a request and gave no answer within 5 seconds");

class SessionRequests extends Context.Service<
	SessionRequests,
	{
		/** Returns once the router stored the pin. */
		readonly pin: (port: number, request: typeof PinRequest.Type) => Effect.Effect<void, Unanswered>;
		readonly status: (port: number, session: string) => Effect.Effect<typeof Status.Type, Unanswered>;
	}
>()("phi-router/router/client/router-port/session-request/SessionRequests") {
	public static readonly layer = Layer.effect(
		SessionRequests,
		Effect.gen(function* make() {
			const client = yield* HttpClient.HttpClient;

			const answerTo = (
				port: number,
				request: (origin: string) => HttpClientRequest.HttpClientRequest,
			): Effect.Effect<string, Unanswered> =>
				client.execute(request(`http://${loopback}:${String(port)}`)).pipe(
					Effect.mapError(() => noRouter),
					Effect.filterOrFail(
						(response) => response.status === ok,
						(response) => unanswered(`it answered ${String(response.status)}`),
					),
					Effect.flatMap((response) => Effect.mapError(response.text, () => noRouter)),
					Effect.scoped,
					Effect.timeoutOrElse({ duration: patience, orElse: () => Effect.fail(stalled) }),
					Effect.provideService(HttpClient.TracerPropagationEnabled, false),
				);

			const pin = Effect.fn("SessionRequests.pin")(function* pin(port: number, request: typeof PinRequest.Type) {
				const body = yield* Effect.orDie(Schema.encodeEffect(PinRequestJson)(request));

				yield* answerTo(port, (origin) =>
					HttpClientRequest.bodyText(
						HttpClientRequest.post(`${origin}${sessionPaths.pin}`),
						body,
						"application/json",
					),
				);
			});

			const status = Effect.fn("SessionRequests.status")(function* status(port: number, session: string) {
				const text = yield* answerTo(port, (origin) =>
					HttpClientRequest.get(`${origin}${sessionPaths.status}`, { urlParams: { session } }),
				);

				return yield* Effect.mapError(Schema.decodeEffect(StatusJson)(text), () =>
					unanswered("its status is not the contract's"),
				);
			});

			return SessionRequests.of({ pin, status });
		}),
	).pipe(Layer.provide(FetchHttpClient.layer));
}

export { PinRequestJson, SessionRequests, sessionPaths };

export type { Unanswered };
