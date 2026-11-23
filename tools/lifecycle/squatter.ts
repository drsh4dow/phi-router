import { Array, Context, Effect, Layer, Ref, Schema, String as Str, Stream, pipe } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Digest } from "effect/crypto";
import { NodeHttpServer } from "@effect/platform-node";
import { proofOf } from "#router/client/proof.ts";
import { writePrivately } from "#router/client/private-file.ts";

/** A secret that is not the developer's: another user's router answers under its own. */
const othersSecret = "7777777777777777777777777777777777777777777777777777777777777777";

/**
 * Leaves the developer's own secret in the router's state folder `state`, as a router they ran before left it, so the
 * listener's answer is checked against a secret it does not hold rather than refused for a missing one.
 */
const secretKept = Effect.fnUntraced(function* secretKept(state: string) {
	yield* writePrivately(`${state}/secret`, "abababababababababababababababababababababababababababababababab");
});

const ProofJson = Schema.fromJsonString(Schema.Struct({ proof: Schema.String }));

const ok = 200;

const chunkBytes = 65_536;

/**
 * Another user's listener on a fresh loopback port, the one it returns: it records each request's method and path, and
 * answers every request with 200 and the proof for its nonce and port under that user's own secret, as their router
 * would.
 */
const squatter = Effect.gen(function* squatter() {
	const built = yield* Layer.build(NodeHttpServer.layerTest);
	const server = Context.get(built, HttpServer.HttpServer);
	const received = yield* Ref.make<readonly string[]>([]);
	const digests = yield* Layer.build(Digest.layerWebCrypto);
	const digest = Context.get(digests, Digest.Digest);
	const port = yield* pipe(HttpServer.formatAddress(server.address), Str.split(":"), Array.last, Effect.fromOption);

	const answer = Effect.gen(function* answer() {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const [path, query = ""] = Str.split(request.url, "?");
		const nonce = new URLSearchParams(query).get("nonce") ?? "";

		yield* request.text;
		yield* Ref.update(received, Array.append(`${request.method} ${path}`));

		const proof = yield* Effect.provideService(proofOf(othersSecret, nonce, Number(port)), Digest.Digest, digest);
		const body = yield* Schema.encodeEffect(ProofJson)({ proof });

		return HttpServerResponse.text(body, { contentType: "application/json", status: ok });
	});

	yield* server.serve(Effect.orDie(answer));

	return { port: Number(port), received: Ref.get(received) };
});

/** A listener on a fresh loopback port, the one it returns, that answers every request with 200 and a body without end. */
const flooder = Effect.gen(function* flooder() {
	const built = yield* Layer.build(NodeHttpServer.layerTest);
	const server = Context.get(built, HttpServer.HttpServer);
	const endless = Stream.forever(Stream.succeed(new Uint8Array(chunkBytes)));

	yield* server.serve(Effect.succeed(HttpServerResponse.stream(endless, { status: ok })));

	return yield* pipe(
		HttpServer.formatAddress(server.address),
		Str.split(":"),
		Array.last,
		Effect.fromOption,
		Effect.map(Number),
	);
});

export { flooder, secretKept, squatter };
