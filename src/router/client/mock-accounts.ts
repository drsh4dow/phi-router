import { Array, Effect, Match, Ref, Schema, String as Str, Stream, Struct, pipe } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Scope } from "effect";

/** JSON a function only reads. */
type Json = boolean | number | string | null | readonly Json[] | { readonly [key: string]: Json };

/** One SSE event of a reply, written as `event: <type>` and `data: <json>`. */
interface Event {
	readonly type: string;
	readonly [key: string]: Json;
}

/**
 * What an account mock is asked: the model, and as JSON text the last message's content, tool results included, or for
 * OpenAI the last input item.
 */
interface Asked {
	readonly model: string;
	readonly last: string;
	/** The whole body, for a script that answers by what it holds anywhere. */
	readonly body: string;
	/** Every header under its lower-case name, for a script that answers by the credential it got. */
	readonly headers: Readonly<Record<string, string>>;
}

/**
 * What an account mock answers. `events` is an SSE reply, each event written as its own chunk when the stream emits it,
 * so a test that feeds the stream from a queue decides when each event leaves. `status` is a whole JSON answer, such as
 * an error or a model catalog. `stalled` is a `status` whose body stops after its first byte and never ends. `redirect`
 * is a 302 to `location`.
 */
type Said =
	| { readonly kind: "events"; readonly events: Stream.Stream<Event> }
	| {
			readonly kind: "status";
			readonly status: number;
			readonly body: string;
			readonly headers?: Readonly<Record<string, string>>;
	  }
	| { readonly kind: "stalled"; readonly status: number }
	| { readonly kind: "redirect"; readonly location: string };

/** One request an account mock received: every header under its lower-case name, its query string, and the raw body. */
interface Sent {
	readonly method: string;
	readonly path: string;
	readonly query: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

interface AccountMock {
	/** `http://127.0.0.1:<port>`, an account's `endpoint`. */
	readonly endpoint: string;
	readonly received: Effect.Effect<readonly Sent[]>;
}

const Turn = Schema.Struct({ content: Schema.Json, role: Schema.String });

const Body = Schema.fromJsonString(Schema.Struct({ messages: Schema.Array(Turn), model: Schema.String }));

const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const Responses = Schema.fromJsonString(
	Schema.Struct({ input: Schema.NonEmptyArray(Schema.Json), model: Schema.String }),
);

const responsesAskedOf = Effect.fnUntraced(function* responsesAskedOf({ body, headers }: Sent) {
	const { input, model } = yield* Schema.decodeEffect(Responses)(body);
	const last = yield* jsonText(Array.lastNonEmpty(input));

	return { body, headers, last, model } satisfies Asked;
});

const askedOf = Effect.fnUntraced(function* askedOf({ body, headers }: Sent) {
	const { messages, model } = yield* Schema.decodeEffect(Body)(body);

	const lastTurn = yield* Effect.fromOption(
		pipe(
			messages,
			Array.findLast((turn) => turn.role !== "system"),
		),
	);

	const last = yield* jsonText(lastTurn.content);

	return { body, headers, last, model } satisfies Asked;
});

const message = {
	content: [],
	id: "msg_mock",
	model: "mock",
	role: "assistant",
	type: "message",
	usage: { input_tokens: 1, output_tokens: 0 },
};

/** One `ping` event, as the Anthropic API sends it between others. */
const ping: Event = { type: "ping" };

/**
 * The events of a text reply, as the pi harness mock wrote them, with one delta per text and a `ping` after each.
 *
 * @param {readonly string[]} texts The text of each delta.
 * @returns {readonly Event[]} The events.
 */
const textEvents = (texts: readonly string[]): readonly Event[] => [
	{ message, type: "message_start" },
	{ content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" },
	...pipe(
		texts,
		Array.flatMap((text) => [{ delta: { text, type: "text_delta" }, index: 0, type: "content_block_delta" }, ping]),
	),
	{ index: 0, type: "content_block_stop" },
	{ delta: { stop_reason: "end_turn" }, type: "message_delta", usage: { output_tokens: 1 } },
	{ type: "message_stop" },
];

/**
 * The events of one tool call, its whole input in one delta.
 *
 * @param {object} call The call's id and tool name, and its input as JSON text.
 * @returns {readonly Event[]} The events.
 */
const toolEvents = (call: { readonly id: string; readonly name: string; readonly input: string }): readonly Event[] => [
	{ message, type: "message_start" },
	{
		content_block: { id: call.id, input: {}, name: call.name, type: "tool_use" },
		index: 0,
		type: "content_block_start",
	},
	{ delta: { partial_json: call.input, type: "input_json_delta" }, index: 0, type: "content_block_delta" },
	{ index: 0, type: "content_block_stop" },
	{ delta: { stop_reason: "tool_use" }, type: "message_delta", usage: { output_tokens: 1 } },
	{ type: "message_stop" },
];

/**
 * The events of a Responses reply holding `items`, each written whole once added and once done, as Codex 0.166.0
 * reads them (measured in the wire run).
 *
 * @param {readonly Json[]} items The reply's output items.
 * @returns {readonly Event[]} The events.
 */
const responseEvents = (items: readonly Json[]): readonly Event[] => {
	const usage = {
		input_tokens: 1,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens: 1,
		output_tokens_details: { reasoning_tokens: 0 },
		total_tokens: 2,
	};

	const response = { id: "resp_mock", model: "mock", object: "response", output: items, status: "completed", usage };

	return [
		{ response: Struct.assign(response, { output: [], status: "in_progress" }), type: "response.created" },
		...pipe(
			items,
			Array.flatMap((item, index) => [
				{ item, output_index: index, type: "response.output_item.added" },
				{ item, output_index: index, type: "response.output_item.done" },
			]),
		),
		{ response, type: "response.completed" },
	];
};

const notFound = 404;

const responseTo = Match.type<Said>().pipe(
	Match.discriminatorsExhaustive("kind")({
		events: ({ events }) => {
			const frames = Stream.mapEffect(events, (event) =>
				Effect.map(jsonText(event), (json) => `event: ${event.type}\ndata: ${json}\n\n`),
			);

			return HttpServerResponse.stream(Stream.encodeText(frames), { contentType: "text/event-stream" });
		},
		redirect: ({ location }) => HttpServerResponse.redirect(location),
		stalled: ({ status }) => {
			const firstByte = Stream.concat(Stream.make("{"), Stream.never);

			return HttpServerResponse.stream(Stream.encodeText(firstByte), { contentType: "application/json", status });
		},
		status: ({ status, body, headers = {} }) =>
			HttpServerResponse.text(body, { contentType: "application/json", headers, status }),
	}),
);

/** An account mock on the caller's `HttpServer` that records every request before `answerOf` answers it. */
const recording = Effect.fnUntraced(function* recording(
	answerOf: (sent: Sent) => Effect.Effect<HttpServerResponse.HttpServerResponse>,
): Effect.fn.Return<AccountMock, never, HttpServer.HttpServer | Scope.Scope> {
	const received = yield* Ref.make<readonly Sent[]>([]);

	const answer = Effect.gen(function* answer() {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const body = yield* request.text;
		const [path, query = ""] = Str.split(request.url, "?");
		const sent = { body, headers: request.headers, method: request.method, path, query };

		yield* Ref.update(received, (all) => [...all, sent]);

		return yield* answerOf(sent);
	});

	const server = yield* HttpServer.HttpServer;

	yield* server.serve(Effect.interruptible(Effect.orDie(answer)));

	return { endpoint: HttpServer.formatAddress(server.address), received: Ref.get(received) };
});

const unknownPath = Effect.succeed(HttpServerResponse.empty({ status: notFound }));

/**
 * An Anthropic account mock, for the open and the BAA account alike. It answers `POST /v1/messages` by `script` and
 * every other request with 404.
 *
 * @param {Function} script How it answers a model request.
 * @returns {Effect.Effect<AccountMock, never, HttpServer.HttpServer | Scope.Scope>} The mock.
 */
const serveAnthropic = (
	script: (asked: Asked) => Said,
): Effect.Effect<AccountMock, never, HttpServer.HttpServer | Scope.Scope> =>
	recording((sent) => {
		if (sent.method !== "POST" || sent.path !== "/v1/messages") {
			return unknownPath;
		}

		return Effect.orDie(Effect.map(askedOf(sent), (asked) => responseTo(script(asked))));
	});

/**
 * An OpenAI account mock, for the open (ChatGPT) and the BAA (API) account alike, at the endpoint its account names. It
 * answers `POST /responses` by `script`, `GET /models` by `catalog`, and every other request with 404.
 *
 * @param {object} scripts How it answers a model request and a catalog request.
 * @returns {Effect.Effect<AccountMock, never, HttpServer.HttpServer | Scope.Scope>} The mock.
 */
const serveOpenAi = (scripts: {
	readonly script: (asked: Asked) => Said;
	readonly catalog: () => Said;
}): Effect.Effect<AccountMock, never, HttpServer.HttpServer | Scope.Scope> =>
	recording((sent) => {
		if (sent.method === "GET" && sent.path === "/models") {
			return Effect.succeed(responseTo(scripts.catalog()));
		}

		if (sent.method !== "POST" || sent.path !== "/responses") {
			return unknownPath;
		}

		return Effect.orDie(Effect.map(responsesAskedOf(sent), (asked) => responseTo(scripts.script(asked))));
	});

export { responseEvents, serveAnthropic, serveOpenAi, textEvents, toolEvents };

export type { AccountMock, Asked, Event, Json, Said, Sent };
