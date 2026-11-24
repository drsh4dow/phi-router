import type { AccountMock, Asked, Event, Reply, Said } from "#router/client/mock-upstreams/index.ts";
import { Array, Context, Effect, FileSystem, Layer, Option, Ref, Schema, String as Str, Stream, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import {
	mockWorld,
	responseEvents,
	serveAnthropic,
	serveOpenAi,
	textEvents,
	toolEvents,
} from "#router/client/mock-upstreams/index.ts";
import type { HttpServer } from "effect/http";
import { Listener } from "#router/client/router-port/index.ts";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { mockOn } from "#tools/judge/configured.ts";

type Script = (asked: Readonly<Asked>) => Said;

type Mock = Effect.Effect<AccountMock, never, HttpServer.HttpServer | Scope.Scope>;

const status = { failed: 500, notFound: 404, ok: 200 } as const;

const posted = (path: string, body: string): HttpClientRequest.HttpClientRequest =>
	HttpClientRequest.post(path).pipe(HttpClientRequest.bodyText(body, "application/json"));

const statusReply: Said = { body: "{}", kind: "status", status: status.ok };

const catalog = (): Said => statusReply;

const servers = {
	anthropic: (script: Script): Mock => serveAnthropic(script),
	openai: (script: Script): Mock => serveOpenAi({ catalog, script }),
};

const served = Effect.fnUntraced(function* served(vendor: keyof typeof servers, script: Script) {
	const server = yield* Layer.build(NodeHttpServer.layerTest);
	const account = yield* Effect.provideContext(servers[vendor](script), server);

	return { account, client: Context.get(server, HttpClient.HttpClient) };
});

const modelRoutes = { anthropic: "/v1/messages", openai: "/responses" } as const;

const greetings = {
	anthropic: '{"messages":[{"content":"Hi.","role":"user"}],"model":"mock"}',
	openai: '{"input":[{"content":"Hi.","role":"user"}],"model":"mock"}',
} as const;

const answer = Effect.fnUntraced(function* answer(vendor: keyof typeof servers, script: Script, body: string) {
	const { client } = yield* served(vendor, script);

	return yield* client.execute(posted(modelRoutes[vendor], body));
});

const eventsReply = (events: readonly Event[]): Said => ({
	events: Stream.fromIterable(events),
	kind: "events",
});

const Typed = Schema.fromJsonString(Schema.Struct({ type: Schema.String }));

const TextDelta = Schema.fromJsonString(Schema.Struct({ delta: Schema.Struct({ text: Schema.String }) }));

const JsonDelta = Schema.fromJsonString(Schema.Struct({ delta: Schema.Struct({ partial_json: Schema.String }) }));

const ItemEvent = Schema.fromJsonString(
	Schema.Struct({ item: Schema.Struct({ id: Schema.String }), type: Schema.String }),
);

const lineHeads = { data: "data: ", event: "event: " } as const;

interface Frame {
	readonly data: string;
	readonly event: string;
}

const frameOf = (lines: readonly string[]): Frame => {
	const [event, data] = lines;

	return {
		data: Str.slice(lineHeads.data.length)(data ?? ""),
		event: Str.slice(lineHeads.event.length)(event ?? ""),
	};
};

const replyFrames = Effect.fnUntraced(function* replyFrames(vendor: keyof typeof servers, script: Script) {
	const response = yield* answer(vendor, script, greetings[vendor]);
	const reply = yield* response.text;
	const frames = pipe(reply, Str.split("\n\n"), Array.filter(Str.isNonEmpty), Array.map(Str.split("\n")));

	return pipe(frames, Array.map(frameOf));
});

const decodedWhere = <Decoded>(
	frames: readonly Frame[],
	event: (name: string) => boolean,
	decode: (data: string) => Effect.Effect<Decoded, Schema.SchemaError>,
): Effect.Effect<readonly Decoded[], Schema.SchemaError> =>
	Effect.forEach(
		pipe(
			frames,
			Array.filter((frame) => event(frame.event)),
		),
		({ data }) => decode(data),
		{ concurrency: 1 },
	);

const namesOf = Array.map(({ event }: Frame) => event);

const typedFrames = Effect.fnUntraced(function* typedFrames(frames: readonly Frame[]) {
	const typed = yield* decodedWhere(frames, () => true, Schema.decodeEffect(Typed));

	assert.deepStrictEqual(
		pipe(
			typed,
			Array.map(({ type }) => type),
		),
		namesOf(frames),
		"each frame's event line names its data's type",
	);
});

const textReply = Effect.gen(function* textReply() {
	const frames = yield* replyFrames("anthropic", () => eventsReply(textEvents(["one", "two"])));

	const deltas = yield* decodedWhere(frames, (name) => name === "content_block_delta", Schema.decodeEffect(TextDelta));

	yield* typedFrames(frames);

	assert.deepStrictEqual(namesOf(frames), [
		"message_start",
		"content_block_start",
		"content_block_delta",
		"ping",
		"content_block_delta",
		"ping",
		"content_block_stop",
		"message_delta",
		"message_stop",
	]);

	assert.deepStrictEqual(
		pipe(
			deltas,
			Array.map(({ delta }) => delta.text),
		),
		["one", "two"],
	);
});

const toolReply = Effect.gen(function* toolReply() {
	const input = '{"path":"notes.md"}';

	const frames = yield* replyFrames("anthropic", () =>
		eventsReply(toolEvents({ id: "toolu_1", input, name: "read" })),
	);

	const deltas = yield* decodedWhere(frames, (name) => name === "content_block_delta", Schema.decodeEffect(JsonDelta));

	assert.deepStrictEqual(
		pipe(
			deltas,
			Array.map(({ delta }) => delta.partial_json),
		),
		[input],
	);
});

const responsesReply = Effect.gen(function* responsesReply() {
	const frames = yield* replyFrames("openai", () => eventsReply(responseEvents([{ id: "first" }, { id: "second" }])));

	const items = yield* decodedWhere(frames, Str.startsWith("response.output_item."), Schema.decodeEffect(ItemEvent));

	assert.deepStrictEqual(namesOf(frames), [
		"response.created",
		"response.output_item.added",
		"response.output_item.done",
		"response.output_item.added",
		"response.output_item.done",
		"response.completed",
	]);

	assert.deepStrictEqual(
		pipe(
			items,
			Array.map(({ item, type }) => `${type} ${item.id}`),
		),
		[
			"response.output_item.added first",
			"response.output_item.done first",
			"response.output_item.added second",
			"response.output_item.done second",
		],
	);
});

const lastOf = (asked: Readonly<Asked>): Said => ({ body: asked.last, kind: "status", status: status.ok });

const toolResult = '[{"content":"result","tool_use_id":"toolu_1","type":"tool_result"}]';

const callOutput = '{"call_id":"call_1","output":"result","type":"function_call_output"}';

const lasts = [
	{
		body: `{"messages":[{"content":"first","role":"user"},{"content":${toolResult},"role":"user"},{"content":"rules","role":"system"}],"model":"mock"}`,
		expected: toolResult,
		name: "Anthropic: the last non-system message's content",
		vendor: "anthropic",
	},
	{
		body: `{"input":[{"content":"first","role":"user"},${callOutput}],"model":"mock"}`,
		expected: callOutput,
		name: "OpenAI: the last input item",
		vendor: "openai",
	},
] as const;

const JsonText = Schema.fromJsonString(Schema.Json);

const lastAsked = Effect.fnUntraced(function* lastAsked({ body, expected, vendor }: (typeof lasts)[number]) {
	const response = yield* answer(vendor, lastOf, body);
	const last = yield* response.text.pipe(Effect.flatMap(Schema.decodeEffect(JsonText)));
	const wanted = yield* Schema.decodeEffect(JsonText)(expected);

	assert.deepStrictEqual(last, wanted);
});

const stalls = Effect.gen(function* stalls() {
	const response = yield* answer("anthropic", () => ({ kind: "stalled", status: status.failed }), greetings.anthropic);
	const seen = yield* Ref.make("");

	const ended = yield* response.stream.pipe(
		Stream.decodeText,
		Stream.runForEach((text) => Ref.update(seen, (before) => before + text)),
		Effect.timeoutOption("300 millis"),
		TestClock.withLive,
	);

	const body = yield* Ref.get(seen);

	assert.deepStrictEqual([response.status, body, Option.isSome(ended)], [status.failed, "{", false]);
});

const offRoute = Effect.gen(function* offRoute() {
	const anthropic = yield* served("anthropic", () => statusReply);
	const openai = yield* served("openai", () => statusReply);

	const responses = yield* Effect.all(
		[
			anthropic.client.execute(HttpClientRequest.get("/v1/models")),
			anthropic.client.execute(posted("/v1/messages", "unreadable")),
			openai.client.execute(posted("/v1/responses", "{}")),
			openai.client.execute(posted("/responses", "unreadable")),
		],
		{ concurrency: 1 },
	);

	const statuses = pipe(
		responses,
		Array.map((response) => response.status),
	);

	const received = yield* Effect.all([anthropic.account.received, openai.account.received], { concurrency: 1 });

	const lines = pipe(received, Array.map(Array.map(({ method, path }) => `${method} ${path}`)));

	assert.deepStrictEqual(
		{ lines, statuses },
		{
			lines: [
				["GET /v1/models", "POST /v1/messages"],
				["POST /v1/responses", "POST /responses"],
			],
			statuses: [status.notFound, status.failed, status.notFound, status.failed],
		},
	);
});

const cleared = (): Reply => ({ body: { answers: [] }, kind: "body" });

const judgeAsked = { input: '{"piece":"the piece"}', model: "judge", questions: [] };

const judgeAskedText = Schema.encodeEffect(JsonText)(judgeAsked);

const followedRedirect = Effect.gen(function* followedRedirect() {
	const elsewhere = yield* mockOn(cleared);
	const redirecting = yield* mockOn(() => ({ kind: "redirect", location: `${elsewhere.endpoint}/decisions` }));
	const client = yield* HttpClient.HttpClient;
	const asked = yield* judgeAskedText;

	yield* client.execute(posted(`${redirecting.endpoint}/decisions`, asked));

	const reached = yield* elsewhere.received;

	assert.deepStrictEqual(
		pipe(
			reached,
			Array.map(({ body, method }) => ({ body, method })),
		),
		[{ body: judgeAsked, method: "POST" }],
	);
});

const answeredAndRecorded = Effect.gen(function* answeredAndRecorded() {
	const judge = yield* mockOn(cleared);
	const client = yield* HttpClient.HttpClient;
	const asked = yield* judgeAskedText;

	const response = yield* client.execute(
		posted(`${judge.endpoint}/decisions`, asked).pipe(HttpClientRequest.setHeader("X-Judge-Test", "seen")),
	);

	const judged = yield* response.text.pipe(Effect.flatMap(Schema.decodeEffect(JsonText)));
	const received = yield* judge.received;

	const headers = pipe(
		received,
		Array.map((request) => request.headers["x-judge-test"]),
	);

	assert.deepStrictEqual(
		{ headers, judged, status: response.status },
		{ headers: ["seen"], judged: { answers: [] }, status: status.ok },
	);
});

const OpenAccount = Schema.Struct({ endpoint: Schema.String });

const WorldConfig = Schema.fromJsonString(Schema.Struct({ clean: Schema.Tuple([OpenAccount]) }));

const testListener = Listener.of({ on: () => NodeHttpServer.layerTest });

const closedWithScope = Effect.gen(function* closedWithScope() {
	const fs = yield* FileSystem.FileSystem;
	const client = yield* HttpClient.HttpClient;

	const { configHome, open } = yield* Effect.scoped(
		Effect.gen(function* opened() {
			const world = yield* mockWorld("anthropic", () => false);
			const file = yield* fs.readFileString(`${world.env.XDG_CONFIG_HOME}/phi-router/config.json`);

			const {
				clean: [account],
			} = yield* Schema.decodeEffect(WorldConfig)(file);

			return { configHome: world.env.XDG_CONFIG_HOME, open: account.endpoint };
		}),
	);

	const folderLeft = yield* fs.exists(configHome);
	const openAnswers = yield* client.get(open).pipe(Effect.isSuccess);

	assert.deepStrictEqual({ folderLeft, openAnswers }, { folderLeft: false, openAnswers: false });
}).pipe(Effect.provideService(Listener, testListener));

it.layer(NodeServices.layer)("an account mock", (test) => {
	test.effect(
		"writes a text reply as one SSE frame per event, one delta per text with a ping after each",
		() => textReply,
	);
	test.effect("sends a tool call's whole input in one delta", () => toolReply);
	test.effect("writes each Responses item whole when it is added and when it is done", () => responsesReply);
	test.effect.each(lasts)("gives its script as the last asked $name, as JSON text", lastAsked);
	test.effect("sends a stalled reply's status and first byte, and never ends it", () => stalls);
	test.effect("records every request, even one it cannot read, and answers 404 off its model route", () => offRoute);
});

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("a judge mock", (test) => {
	test.effect(
		"redirects so that a client following it as fetch does sends the piece on to its location",
		() => followedRedirect,
	);
	test.effect(
		"answers a body reply with 200 and its JSON, and records each header under its lower-case name",
		() => answeredAndRecorded,
	);
});

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("the doctor's mock world", (test) => {
	test.effect("closes its mocks and removes its folders when its scope closes", () => closedWithScope);
});
