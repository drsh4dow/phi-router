import { Effect, Layer, flow } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

/**
 * The HTTP client of every call to an upstream, an account or the judge. It follows no redirect, so no body or key
 * goes to a host the configuration does not name, and it adds no trace header. It sets both around each call, because
 * the entry file shares one fetch layer with the lease client, which a setting given to the layer would not reach.
 */
const upstreamHttp: Layer.Layer<HttpClient.HttpClient> = Layer.effect(
	HttpClient.HttpClient,
	Effect.gen(function* upstreamHttp() {
		const fetching = yield* HttpClient.HttpClient;

		return HttpClient.transformResponse(
			fetching,
			flow(
				Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
				Effect.provideService(HttpClient.TracerPropagationEnabled, false),
			),
		);
	}),
).pipe(Layer.provide(FetchHttpClient.layer));

export { upstreamHttp };
