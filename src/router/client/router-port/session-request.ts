import type { AnswerCheck, AnswerChecked, Status } from "#shared/cli.ts";
import { AnswerCheckJson, AnswerCheckedJson, StatusJson } from "#shared/cli.ts";
import { Context, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { callerHeaders } from "./caller-token.ts";
import { loopback } from "./server.ts";

const sessionPaths = { answerCheck: "/phi-router/answer-check", status: "/phi-router/status" } as const;

const ok = 200;

const patience = { answerCheck: "30 seconds", status: "5 seconds" } as const;

type Patience = (typeof patience)[keyof typeof patience];

interface Unanswered {
	readonly reason:
		| "no router answers there"
		| `it answered ${number}`
		| `it took a request and gave no answer within ${Patience}`
		| "its status is not the contract's"
		| "its answer check is not the contract's";
}

const unanswered = (reason: Unanswered["reason"]): Unanswered => ({ reason });

const noRouter = unanswered("no router answers there");

const stalledFor = (waited: Patience): Unanswered =>
	unanswered(`it took a request and gave no answer within ${waited}`);

const signedTo = (
	port: number,
	request: (origin: string) => HttpClientRequest.HttpClientRequest,
): Effect.Effect<HttpClientRequest.HttpClientRequest> =>
	callerHeaders.pipe(
		Effect.map((headers) => {
			const sent = request(`http://${loopback}:${String(port)}`);

			return HttpClientRequest.setHeaders(sent, headers);
		}),
	);

class SessionRequests extends Context.Service<
	SessionRequests,
	{
		readonly status: (port: number, session: string) => Effect.Effect<typeof Status.Type, Unanswered>;
		readonly answerCheck: (
			port: number,
			asked: typeof AnswerCheck.Type,
		) => Effect.Effect<typeof AnswerChecked.Type, Unanswered>;
	}
>()("phi-router/router/client/router-port/session-request/SessionRequests") {
	public static readonly layer = Layer.effect(
		SessionRequests,
		Effect.gen(function* make() {
			const client = yield* HttpClient.HttpClient;

			const answerTo = (
				port: number,
				waited: Patience,
				request: (origin: string) => HttpClientRequest.HttpClientRequest,
			): Effect.Effect<string, Unanswered> =>
				signedTo(port, request).pipe(
					Effect.flatMap((sent) => client.execute(sent)),
					Effect.mapError(() => noRouter),
					Effect.filterOrFail(
						(response) => response.status === ok,
						(response) => unanswered(`it answered ${response.status}`),
					),
					Effect.flatMap((response) => Effect.mapError(response.text, () => noRouter)),
					Effect.scoped,
					Effect.timeoutOrElse({ duration: waited, orElse: () => Effect.fail(stalledFor(waited)) }),
					Effect.provideService(HttpClient.TracerPropagationEnabled, false),
				);

			const status = Effect.fn("SessionRequests.status")(function* status(port: number, session: string) {
				const text = yield* answerTo(port, patience.status, (origin) =>
					HttpClientRequest.get(`${origin}${sessionPaths.status}`, { urlParams: { session } }),
				);

				return yield* Effect.mapError(Schema.decodeEffect(StatusJson)(text), () =>
					unanswered("its status is not the contract's"),
				);
			});

			const answerCheck = Effect.fn("SessionRequests.answerCheck")(function* answerCheck(
				port: number,
				asked: typeof AnswerCheck.Type,
			) {
				const body = yield* Effect.orDie(Schema.encodeEffect(AnswerCheckJson)(asked));

				const text = yield* answerTo(port, patience.answerCheck, (origin) =>
					HttpClientRequest.post(`${origin}${sessionPaths.answerCheck}`).pipe(
						HttpClientRequest.bodyText(body, "application/json"),
					),
				);

				return yield* Effect.mapError(Schema.decodeEffect(AnswerCheckedJson)(text), () =>
					unanswered("its answer check is not the contract's"),
				);
			});

			return SessionRequests.of({ answerCheck, status });
		}),
	).pipe(Layer.provide(FetchHttpClient.layer));
}

export { SessionRequests, sessionPaths };

export type { Unanswered };
