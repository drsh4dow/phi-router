import { Array, Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { Outgoing, Path as Row } from "./server.ts";
import { Digest } from "effect/crypto";
import { Hex } from "effect/encoding";
import type { PlatformError } from "effect";
import { UserDirectories } from "effect/persistence";
import { loopback } from "./server.ts";
import { writePrivately } from "#router/client/private-file.ts";

/** The proof row of the router's path table. The nonce goes in the query. */
const proofPath = "/phi-router/proof";

/** How many random bytes the secret and each nonce hold. */
const randomBytes = 32;

/** The secret, and each nonce: 32 random bytes as 64 lowercase hex digits. */
const Random = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

const ProofJson = Schema.fromJsonString(Schema.Struct({ proof: Schema.String }));

/** The most of an answer `ask` reads, far above a proof's, so a listener cannot make it read forever. */
const answerLimit = 1024;

const statuses = { badRequest: 400, ok: 200, unavailable: 503 } as const;

/** The block size of SHA-256, which the secret's 64 digits fill exactly, and the pads of RFC 2104, 0x36 and 0x5c. */
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

/**
 * One HMAC block and what follows it.
 *
 * @param {readonly number[]} key The key's bytes, which the block pads with zeros.
 * @param {number} pad The pad each byte of the block is combined with.
 * @param {readonly number[]} text The bytes after the block.
 * @returns {Uint8Array} The bytes to hash.
 */
const keyed = (key: readonly number[], pad: number, text: readonly number[]): Uint8Array<ArrayBuffer> =>
	Uint8Array.from([...Array.makeBy(hmac.block, (index) => xor(key[index] ?? zero, pad)), ...text]);

const bytesOf = (text: string): readonly number[] => Array.fromIterable(encoder.encode(text));

/** The key as HMAC uses it: its bytes, hashed first when they are longer than a block. */
const blockKey = Effect.fnUntraced(function* blockKey(key: readonly number[]) {
	if (key.length <= hmac.block) {
		return key;
	}

	const digest = yield* Digest.Digest;
	const hashed = yield* digest.digest(Digest.sha256, Uint8Array.from(key));

	return Array.fromIterable(hashed);
});

/**
 * HMAC-SHA-256 (RFC 2104) of `message` under `key`, in hex. It is built from Effect's SHA-256, since the lint bans
 * `node:crypto` and Effect has no HMAC.
 */
const hmacOf = Effect.fnUntraced(function* hmacOf(key: readonly number[], message: readonly number[]) {
	const digest = yield* Digest.Digest;
	const padded = yield* blockKey(key);
	const inner = yield* digest.digest(Digest.sha256, keyed(padded, hmac.inner, message));

	return yield* digest.digestHex(Digest.sha256, keyed(padded, hmac.outer, Array.fromIterable(inner)));
});

/**
 * The proof a router on `port` gives for `nonce`: the HMAC of both under `secret`. The port is in it, so another
 * listener cannot pass off the answer of the developer's router on another port as its own.
 */
const proofOf = Effect.fnUntraced(function* proofOf(secret: string, nonce: string, port: number) {
	return yield* hmacOf(bytesOf(secret), bytesOf(`${nonce}:${String(port)}`));
});

/** 32 bytes from the operating system's random source, in hex. */
const fresh = Effect.gen(function* fresh() {
	const fs = yield* FileSystem.FileSystem;
	const bytes = yield* Stream.mkUint8Array(fs.stream("/dev/urandom", { bytesToRead: randomBytes }));

	return Hex.encode(bytes);
});

const storedIn = Effect.fnUntraced(function* storedIn(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(file);

	return yield* Schema.decodeEffect(Random)(text);
});

/**
 * The proof row of a router on `port`. It writes a fresh secret to `file` when the file holds none, and reads the file
 * again for each answer, so routers that start at once on two ports and each write a secret answer under the one that
 * stayed.
 */
const rowOf = Effect.fnUntraced(function* rowOf(file: string, port: number) {
	yield* storedIn(file).pipe(Effect.catch(() => fresh.pipe(Effect.flatMap((secret) => writePrivately(file, secret)))));

	const services = yield* Effect.context<FileSystem.FileSystem | Digest.Digest>();

	const answer: Row["answer"] = ({ query }) =>
		pipe(
			Schema.decodeUnknownEffect(Random)(query["nonce"]),
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

/**
 * What the listener on a port did with a fresh nonce. `proved`: it answered with the nonce's HMAC under this user's
 * secret. `refuted`: it answered anything else, or this user's secret cannot be read. `unanswered`: no connection
 * opened, so nothing listens there. `waiting`: it answered 503, as a router that is starting up does.
 */
type Proven = "proved" | "refuted" | "unanswered" | "waiting";

/** Whether an answer with `status` and `body` holds the proof for `nonce` and `port` under the secret in `file`. */
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

/**
 * The proof that the listener on the router's port is this user's router (ADR 0002): the HMAC of a nonce under the
 * secret in `phi-router/secret` under the XDG state folder, which only this user can read.
 */
class Proofs extends Context.Service<
	Proofs,
	{
		/**
		 * The proof row of the path table of the router on `port`, under the stored secret, or under a fresh one it
		 * writes when the file holds none. Only `serve` builds it, once it holds the port.
		 */
		readonly row: (port: number) => Effect.Effect<Row, PlatformError.PlatformError>;
		/** Sends the listener on `port` a fresh nonce and checks its answer against the stored secret. */
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
