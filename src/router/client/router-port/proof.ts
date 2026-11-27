import { Array, Context, Effect, FileSystem, Layer, Option, Path, Record, Schema, Stream, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { Mac, SecureRandom } from "effect/crypto";
import type { Outgoing, Path as Row } from "./server.ts";
import { callerHeader, storedToken, tokenUsed } from "./caller-token.ts";
import { Hex } from "effect/encoding";
import type { PlatformError } from "effect";
import { Release } from "#router/primitives/release.ts";
import { UserDirectories } from "effect/persistence";
import { loopback } from "#shared/cli.ts";
import { writePrivately } from "#router/client/private-file.ts";

const proofPath = "/phi-router/proof";

const randomBytes = 32;

const Secret = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

const Nonce = Secret;

const ProofJson = Schema.fromJsonString(
	Schema.Struct({ proof: Schema.String, version: Schema.OptionFromOptionalKey(Schema.String) }),
);

const answerLimit = 1024;

const statuses = { badRequest: 400, ok: 200, unavailable: 503 } as const;

const encoder = new TextEncoder();

const bytesOf = (text: string): readonly number[] => Array.fromIterable(encoder.encode(text));

const macs = Mac.layerWebCrypto.pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));

const hmacOf = Effect.fnUntraced(function* hmacOf(key: readonly number[], message: readonly number[]) {
	const mac = yield* Mac.Mac;
	const secret = yield* Mac.key(Mac.hmacSha256, Uint8Array.from(key));
	const tag = yield* mac.sign(secret, Uint8Array.from(message));

	return Hex.encode(tag);
});

type Answering = FileSystem.FileSystem | Mac.Mac | SecureRandom.SecureRandom;

const proofOf = Effect.fnUntraced(function* proofOf(secret: string, nonce: string, port: number) {
	return yield* hmacOf(bytesOf(secret), bytesOf(`${nonce}:${String(port)}`));
});

const fresh = Effect.gen(function* fresh() {
	const random = yield* SecureRandom.SecureRandom;
	const bytes = yield* random.randomBytes(randomBytes);

	return Hex.encode(bytes);
});

const storedIn = Effect.fnUntraced(function* storedIn(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(file);

	return yield* Schema.decodeEffect(Secret)(text);
});

const rowOf = Effect.fnUntraced(function* rowOf(file: string, port: number, version: string | undefined) {
	yield* storedIn(file).pipe(Effect.catch(() => fresh.pipe(Effect.flatMap((secret) => writePrivately(file, secret)))));

	const services = yield* Effect.context<Answering>();

	const answer: Row["answer"] = ({ query }) =>
		pipe(
			Schema.decodeUnknownEffect(Nonce)(query["nonce"]),
			Effect.flatMap((nonce) => Effect.flatMap(storedIn(file), (secret) => proofOf(secret, nonce, port))),
			Effect.provideContext(services),
			Effect.flatMap((proof) => Schema.encodeEffect(ProofJson)({ proof, version: Option.fromUndefinedOr(version) })),
			Effect.match({
				onFailure: (): Outgoing => ({ body: '{"proof":null}', kind: "whole", status: statuses.badRequest }),
				onSuccess: (body): Outgoing => ({ body, kind: "whole", status: statuses.ok }),
			}),
		);

	return { answer, method: "GET", path: proofPath } satisfies Row;
});

type Proven =
	| { readonly kind: "proved"; readonly version: Option.Option<typeof Release.Type> }
	| { readonly kind: "refuted" | "unanswered" | "waiting" };

const refuted: Proven = { kind: "refuted" };

type Headers = Readonly<Record<string, string>>;

const noHeaders: Headers = Record.empty<string, string>();

const provenBy = Effect.fnUntraced(function* provenBy(answer: {
	readonly status: number;
	readonly body: string;
	readonly nonce: string;
	readonly port: number;
	readonly file: string;
}) {
	if (answer.status === statuses.unavailable) {
		return { kind: "waiting" } satisfies Proven;
	}

	const { proof, version } = yield* Schema.decodeEffect(ProofJson)(answer.body);
	const secret = yield* storedIn(answer.file);
	const expected = yield* proofOf(secret, answer.nonce, answer.port);

	if (answer.status === statuses.ok && proof === expected) {
		const reported = pipe(version, Option.filter(Schema.is(Release)));

		return { kind: "proved", version: reported } satisfies Proven;
	}

	return refuted;
});

class Proofs extends Context.Service<
	Proofs,
	{
		readonly row: (port: number, version: string | undefined) => Effect.Effect<Row, PlatformError.PlatformError>;
		readonly ask: (port: number) => Effect.Effect<Proven>;
		readonly callerHeaders: (port: number) => Effect.Effect<Headers>;
	}
>()("phi-router/router/client/router-port/proof/Proofs") {
	public static readonly layer = Layer.effect(
		Proofs,
		Effect.gen(function* make() {
			const client = yield* HttpClient.HttpClient;
			const directories = yield* UserDirectories.UserDirectories;
			const path = yield* Path.Path;
			const services = yield* Effect.context<Answering | Path.Path | Effect.Services<ReturnType<typeof rowOf>>>();
			const state = yield* directories.state("phi-router");
			const file = path.join(state, "secret");

			const ask = (port: number): Effect.Effect<Proven> =>
				Effect.gen(function* asked() {
					const nonce = yield* fresh;
					const url = `http://${loopback}:${String(port)}${proofPath}`;
					const sent = HttpClientRequest.get(url, { urlParams: { nonce } });
					const answered = yield* Effect.option(client.execute(sent));

					if (Option.isNone(answered)) {
						return { kind: "unanswered" } satisfies Proven;
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
					Effect.orElseSucceed(() => refuted),
					Effect.scoped,
					Effect.provideContext(services),
					Effect.provideService(HttpClient.TracerPropagationEnabled, false),
				);

			const callerHeaders = (port: number): Effect.Effect<Headers> =>
				Effect.gen(function* signed() {
					if (!tokenUsed(path)) {
						return noHeaders;
					}

					const proven = yield* ask(port);

					if (proven.kind !== "proved") {
						return noHeaders;
					}

					const token = yield* storedToken;

					return Record.singleton(callerHeader, token);
				}).pipe(
					Effect.orElseSucceed(() => noHeaders),
					Effect.provideContext(services),
				);

			return Proofs.of({
				ask,
				callerHeaders,
				row: (port, version) => Effect.provideContext(rowOf(file, port, version), services),
			});
		}),
	).pipe(Layer.provide(Layer.mergeAll(FetchHttpClient.layer, UserDirectories.layer, macs)));
}

export { Proofs, bytesOf, hmacOf, macs, proofOf, proofPath };
