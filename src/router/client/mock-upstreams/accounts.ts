import { Array, Effect, Match, Ref, Schema, String as Str, Stream, Struct, pipe } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Scope } from "effect";

type Json = boolean | number | string | null | readonly Json[] | { readonly [key: string]: Json };

interface Event {
	readonly type: string;
	readonly [key: string]: Json;
}

interface Asked {
	readonly model: string;
	readonly last: string;
	readonly body: string;
	readonly headers: Readonly<Record<string, string>>;
}

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

interface Sent {
	readonly method: string;
	readonly path: string;
	readonly query: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

interface AccountMock {
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

const ping: Event = { type: "ping" };

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

const serveAnthropic = (
	script: (asked: Asked) => Said,
): Effect.Effect<AccountMock, never, HttpServer.HttpServer | Scope.Scope> =>
	recording((sent) => {
		if (sent.method !== "POST" || sent.path !== "/v1/messages") {
			return unknownPath;
		}

		return Effect.orDie(Effect.map(askedOf(sent), (asked) => responseTo(script(asked))));
	});

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
