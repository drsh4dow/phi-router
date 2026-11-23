import { Effect, Latch, Match, Option, Ref, Schema, String as Str, pipe } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Scope } from "effect";

/**
 * What the mock answers to one request: status 200 with a JSON body, a bare status such as 500, a 307 to `location`,
 * or silence, which keeps the request open until the caller hangs up.
 */
type Reply =
	| { readonly kind: "body"; readonly body: Schema.Json }
	| { readonly kind: "status"; readonly status: number }
	| { readonly kind: "redirect"; readonly location: string }
	| { readonly kind: "silence" };

/** One request the judge mock received, with every header under its lower-case name. */
interface Received {
	readonly bearer: string | undefined;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Schema.Json;
	readonly method: string;
	readonly path: string;
}

interface JudgeMock {
	readonly endpoint: string;
	readonly received: Effect.Effect<readonly Received[]>;
	readonly silenced: Effect.Effect<void>;
	readonly hungUp: Effect.Effect<void>;
}

const Said = Schema.fromJsonString(Schema.Struct({ piece: Schema.String }));

const Questions = Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String }));

const AskedInText = Schema.fromJsonString(Schema.Struct({ input: Said, model: Schema.String, questions: Questions }));

const Text = Schema.Struct({ text: Said });

const Message = Schema.Struct({
	content: Schema.TupleWithRest(Schema.Tuple([Text]), [Schema.Unknown]),
	role: Schema.Literal("user"),
});

const AskedInMessage = Schema.fromJsonString(
	Schema.Struct({ input: Schema.Tuple([Message]), model: Schema.String, questions: Questions }),
);

const JsonText = Schema.fromJsonString(Schema.Json);

const badRequest = 400;

/** A followed 307 sends the same body again, so the piece itself would reach `location`. */
const temporaryRedirect = 307;

const pieceIn = (text: string): Option.Option<string> => {
	const inText = Option.map(Schema.decodeOption(AskedInText)(text), ({ input }) => input.piece);

	return Option.orElse(inText, () =>
		Option.map(
			Schema.decodeOption(AskedInMessage)(text),
			({
				input: [
					{
						content: [first],
					},
				],
			}) => first.text.piece,
		),
	);
};

const responseTo = Match.type<Reply>().pipe(
	Match.discriminatorsExhaustive("kind")({
		body: ({ body }) => Option.some(HttpServerResponse.jsonUnsafe(body)),
		redirect: ({ location }) => Option.some(HttpServerResponse.redirect(location, { status: temporaryRedirect })),
		silence: () => Option.none(),
		status: ({ status }) => Option.some(HttpServerResponse.empty({ status })),
	}),
);

/**
 * A judge mock on the caller's `HttpServer` that records each request and answers it by `script`, so the router and
 * the tests serve the same mock over any server.
 */
const serveJudge = Effect.fnUntraced(function* serveJudge(
	script: (piece: string) => Reply,
): Effect.fn.Return<JudgeMock, never, HttpServer.HttpServer | Scope.Scope> {
	const received = yield* Ref.make<readonly Received[]>([]);
	const silenced = yield* Latch.make();
	const hungUp = yield* Latch.make();
	const silence = Effect.andThen(silenced.open, Effect.never).pipe(Effect.onInterrupt(() => hungUp.open));

	const recorded = Effect.gen(function* recorded() {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const text = yield* request.text;
		const body = Option.getOrElse(Schema.decodeOption(JsonText)(text), () => text);
		const authorization = Option.fromNullishOr(request.headers["authorization"]);
		const bearer = pipe(authorization, Option.map(Str.replace(/^Bearer /u, "")), Option.getOrUndefined);

		const sent = { bearer, body, headers: request.headers, method: request.method, path: request.url };

		yield* Ref.update(received, (all) => [...all, sent]);

		return text;
	});

	const answer = recorded.pipe(
		Effect.flatMap((text) =>
			Option.match(pieceIn(text), {
				onNone: () => Effect.succeed(HttpServerResponse.empty({ status: badRequest })),
				onSome: (piece) =>
					Option.match(responseTo(script(piece)), { onNone: () => silence, onSome: Effect.succeed }),
			}),
		),
	);

	const server = yield* HttpServer.HttpServer;

	yield* server.serve(Effect.interruptible(answer));

	return {
		endpoint: `${HttpServer.formatAddress(server.address)}/v1`,
		hungUp: hungUp.await,
		received: Ref.get(received),
		silenced: silenced.await,
	};
});

/**
 * A judge script that seals each piece `holdsPhi` names and clears the rest. A sealing answer scores 1 and names no
 * kind, so the engine seals the piece unlabelled.
 *
 * @param {Function} holdsPhi Whether a piece holds PHI.
 * @returns {Function} The script.
 */
const sealingWhen =
	(holdsPhi: (piece: string) => boolean) =>
	(piece: string): Reply => ({
		body: {
			answers: [
				{ name: "identifier", probability: Number(holdsPhi(piece)), type: "predicate" },
				{ choice: "none", confidence: 1, name: "kind", probabilities: [], type: "choice" },
			],
			usage: { input_tokens: 1 },
		},
		kind: "body",
	});

export { sealingWhen, serveJudge };

export type { Reply };
