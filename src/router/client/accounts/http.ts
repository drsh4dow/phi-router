import { Effect, Layer, flow } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

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
