import { Config, Context, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { Vendor } from "./lane-configuration.ts";

/** What a vendor said of a key: it took it, it refused it, or it gave no answer setup can read. */
type KeyCheck = "accepted" | "refused" | "unanswered";

/** Each vendor's API, where `GET /v1/models` runs no model and answers 401 to a key it refuses. */
const apis = { anthropic: "https://api.anthropic.com", openai: "https://api.openai.com" } as const;

/** The headers that carry `key` to each vendor. */
const signed = {
	anthropic: (key: string) => HttpClientRequest.setHeaders({ "anthropic-version": "2023-06-01", "x-api-key": key }),
	openai: (key: string) => HttpClientRequest.bearerToken(key),
} as const;

const unauthorized = 401;

const forbidden = 403;

const refusals = new Set([unauthorized, forbidden]);

const okStatus = { high: 300, low: 200 } as const;

const patience = "30 seconds";

const checkOf = (status: number): KeyCheck => {
	if (refusals.has(status)) {
		return "refused";
	}

	if (status >= okStatus.low && status < okStatus.high) {
		return "accepted";
	}

	return "unanswered";
};

/**
 * Asks a vendor whether it takes a key, with one request for its model list, which runs no model. A test points it at
 * a mock with `PHI_ROUTER_KEY_CHECK_ENDPOINT`, which stands for both vendors' API. The key goes only in the request's
 * header.
 */
class KeyChecks extends Context.Service<
	KeyChecks,
	{ readonly check: (vendor: Vendor, key: Readonly<Redacted.Redacted>) => Effect.Effect<KeyCheck> }
>()("phi-router/router/client/key-check/KeyChecks") {
	public static readonly layer = Layer.effect(
		KeyChecks,
		Effect.gen(function* make() {
			const client = yield* HttpClient.HttpClient;

			const check = (vendor: Vendor, key: Readonly<Redacted.Redacted>): Effect.Effect<KeyCheck> =>
				Effect.gen(function* checked() {
					const api = yield* Config.String("PHI_ROUTER_KEY_CHECK_ENDPOINT").pipe(
						Config.withDefault(apis[vendor]),
						Effect.orElseSucceed(() => apis[vendor]),
					);

					const request = HttpClientRequest.get(`${api}/v1/models`).pipe(signed[vendor](Redacted.value(key)));

					return yield* client.execute(request).pipe(
						Effect.timeout(patience),
						Effect.match({
							onFailure: (): KeyCheck => "unanswered",
							onSuccess: ({ status }) => checkOf(status),
						}),
					);
				}).pipe(Effect.scoped, Effect.provideService(HttpClient.TracerPropagationEnabled, false));

			return KeyChecks.of({ check });
		}),
	).pipe(Layer.provide(FetchHttpClient.layer));
}

export { KeyChecks };
