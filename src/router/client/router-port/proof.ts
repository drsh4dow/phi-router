import { Array, Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { Outgoing, Path as Row } from "./server.ts";
import { Digest } from "effect/crypto";
import { Hex } from "effect/encoding";
import type { PlatformError } from "effect";
import { UserDirectories } from "effect/persistence";
import { loopback } from "./server.ts";
import { writePrivately } from "#router/client/private-file.ts";

const proofPath = "/phi-router/proof";

const randomBytes = 32;

const Secret = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

const Nonce = Secret;

const ProofJson = Schema.fromJsonString(Schema.Struct({ proof: Schema.String }));

const answerLimit = 1024;

const statuses = { badRequest: 400, ok: 200, unavailable: 503 } as const;

const hmac = { block: 64, inner: 54, outer: 92 } as const;

const bitsPerByte = 8;

const binary = 2;

const zero = 0;

const encoder = new TextEncoder();

/**
 * The exclusive or of two bytes, as the sum of their bits' differences, since the lint bans bitwise operators.
 *
 * @param {number} first A byte.
 * @param {number} second A byte.
 * @returns {number} The byte.
 */
const xor = (first: number, second: number): number =>
	Array.reduce(
		Array.makeBy(bitsPerByte, (bit) => binary ** bit),
		zero,
		(sum, place) =>
			sum + place * Math.abs((Math.floor(first / place) % binary) - (Math.floor(second / place) % binary)),
	);

const keyed = (key: readonly number[], pad: number, text: readonly number[]): Uint8Array<ArrayBuffer> =>
	Uint8Array.from([...Array.makeBy(hmac.block, (index) => xor(key[index] ?? zero, pad)), ...text]);

const bytesOf = (text: string): readonly number[] => Array.fromIterable(encoder.encode(text));

const blockKey = Effect.fnUntraced(function* blockKey(key: readonly number[]) {
	if (key.length <= hmac.block) {
		return key;
	}

	const digest = yield* Digest.Digest;
	const hashed = yield* digest.digest(Digest.sha256, Uint8Array.from(key));

	return Array.fromIterable(hashed);
});

const hmacOf = Effect.fnUntraced(function* hmacOf(key: readonly number[], message: readonly number[]) {
	const digest = yield* Digest.Digest;
	const padded = yield* blockKey(key);
	const inner = yield* digest.digest(Digest.sha256, keyed(padded, hmac.inner, message));

	return yield* digest.digestHex(Digest.sha256, keyed(padded, hmac.outer, Array.fromIterable(inner)));
});

const proofOf = Effect.fnUntraced(function* proofOf(secret: string, nonce: string, port: number) {
	return yield* hmacOf(bytesOf(secret), bytesOf(`${nonce}:${String(port)}`));
});

const fresh = Effect.gen(function* fresh() {
	const fs = yield* FileSystem.FileSystem;
	const bytes = yield* Stream.mkUint8Array(fs.stream("/dev/urandom", { bytesToRead: randomBytes }));

	return Hex.encode(bytes);
});

const storedIn = Effect.fnUntraced(function* storedIn(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(file);

	return yield* Schema.decodeEffect(Secret)(text);
});

const rowOf = Effect.fnUntraced(function* rowOf(file: string, port: number) {
	yield* storedIn(file).pipe(Effect.catch(() => fresh.pipe(Effect.flatMap((secret) => writePrivately(file, secret)))));

	const services = yield* Effect.context<FileSystem.FileSystem | Digest.Digest>();

	const answer: Row["answer"] = ({ query }) =>
		pipe(
			Schema.decodeUnknownEffect(Nonce)(query["nonce"]),
			Effect.flatMap((nonce) => Effect.flatMap(storedIn(file), (secret) => proofOf(secret, nonce, port))),
			Effect.provideContext(services),
			Effect.flatMap((proof) => Schema.encodeEffect(ProofJson)({ proof })),
			Effect.match({
				onFailure: (): Outgoing => ({ body: '{"proof":null}', kind: "whole", status: statuses.badRequest }),
				onSuccess: (body): Outgoing => ({ body, kind: "whole", status: statuses.ok }),
			}),
		);

	return { answer, method: "GET", path: proofPath } satisfies Row;
});

type Proven = "proved" | "refuted" | "unanswered" | "waiting";

const provenBy = Effect.fnUntraced(function* provenBy(answer: {
	readonly status: number;
	readonly body: string;
	readonly nonce: string;
	readonly port: number;
	readonly file: string;
}) {
	if (answer.status === statuses.unavailable) {
		return "waiting";
	}

	const { proof } = yield* Schema.decodeEffect(ProofJson)(answer.body);
	const secret = yield* storedIn(answer.file);
	const expected = yield* proofOf(secret, answer.nonce, answer.port);

	if (answer.status === statuses.ok && proof === expected) {
		return "proved";
	}

	return "refuted";
});

class Proofs extends Context.Service<
	Proofs,
	{
		readonly row: (port: number) => Effect.Effect<Row, PlatformError.PlatformError>;
		readonly ask: (port: number) => Effect.Effect<Proven>;
	}
>()("phi-router/router/client/router-port/proof/Proofs") {
	public static readonly layer = Layer.effect(
		Proofs,
		Effect.gen(function* make() {
			const client = yield* HttpClient.HttpClient;
			const directories = yield* UserDirectories.UserDirectories;
			const path = yield* Path.Path;
			const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | Digest.Digest>();
			const state = yield* directories.state("phi-router");
			const file = path.join(state, "secret");

			const ask = (port: number): Effect.Effect<Proven> =>
				Effect.gen(function* asked() {
					const nonce = yield* fresh;
					const url = `http://${loopback}:${String(port)}${proofPath}`;
					const sent = HttpClientRequest.get(url, { urlParams: { nonce } });
					const answered = yield* Effect.option(client.execute(sent));

					if (Option.isNone(answered)) {
						return "unanswered";
					}

					const body = yield* answered.value.stream.pipe(
						Stream.decodeText,
						Stream.scan(
							() => "",
							(read: string, chunk: string) => `${read}${chunk}`,
						),
						Stream.takeUntil((read) => read.length > answerLimit),
						Stream.runLast,
						Effect.map(Option.getOrElse(() => "")),
					);

					return yield* provenBy({ body, file, nonce, port, status: answered.value.status });
				}).pipe(
					Effect.orElseSucceed((): Proven => "refuted"),
					Effect.scoped,
					Effect.provideContext(services),
					Effect.provideService(HttpClient.TracerPropagationEnabled, false),
				);

			return Proofs.of({ ask, row: (port) => Effect.provideContext(rowOf(file, port), services) });
		}),
	).pipe(Layer.provide(Layer.mergeAll(FetchHttpClient.layer, UserDirectories.layer, Digest.layerWebCrypto)));
}

export { Proofs, hmacOf, proofOf };
