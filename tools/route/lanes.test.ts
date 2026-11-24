import { Array, Effect, FileSystem, Option, Path, Schema, String as Str, Stream, Struct, pipe } from "effect";
import type { LaneLogLine, Post, Turn } from "./mocked-router.ts";
import type { Said, Sent } from "#router/client/mock-upstreams/index.ts";
import { assert, it } from "@effect/vitest";
import { beta, bodyOf, fakes, laneLines, routed } from "./mocked-router.ts";
import { HttpClientRequest } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import { headersNamed } from "./harnesses.ts";
import { stubsFor } from "#router/features/border/index.ts";
import { textEvents } from "#router/client/mock-upstreams/index.ts";

const canary = "PATIENT-CANARY-7Q4K";

const holdsCanary = Str.includes(canary);

const none = 0;

const status = { ok: 200, rateLimited: 429, unreadable: 400 } as const;

const turns = {
	clean: { role: "user", text: "List the build steps." },
	cleared: { role: "assistant", text: "ok" },
	followUp: { role: "user", text: "Go on." },
	phi: { role: "user", text: `Member ${canary} called.` },
	sealedReply: { role: "assistant", text: "noted" },
} as const satisfies Record<string, Turn>;

const conversation: readonly (readonly Turn[])[] = [
	[turns.clean],
	[turns.clean, turns.cleared, turns.phi],
	[turns.clean, turns.cleared, turns.phi, turns.sealedReply, turns.followUp],
];

/** Where the canary's message sits in the follow-up. */
const phiAt = 2;

const Block = Schema.Struct({ text: Schema.String });

const Message = Schema.Struct({ content: Schema.Array(Block) });

const Body = Schema.fromJsonString(Schema.Struct({ messages: Schema.Array(Message), model: Schema.String }));

const shown = ["anthropic-beta", "authorization", "b3", "traceparent", "x-api-key", "x-not-carried"];

const viewOf = Effect.fnUntraced(function* viewOf(sent: Sent) {
	const { messages, model } = yield* Schema.decodeEffect(Body)(sent.body);

	const atPhi = pipe(
		Array.get(messages, phiAt),
		Option.flatMap(({ content }) => Array.head(content)),
		Option.map(({ text }) => text),
	);

	return { atPhi, canary: holdsCanary(sent.body), headers: headersNamed(shown)(sent.headers), model };
});

const noted = (): Said => ({ events: Stream.fromIterable(textEvents([turns.sealedReply.text])), kind: "events" });

const postedIn = Effect.fnUntraced(function* postedIn(
	post: Post,
	request: { readonly session: string; readonly turns: readonly Turn[] },
) {
	const body = yield* bodyOf(request.turns);
	const response = yield* post({ body, session: request.session });
	const text = yield* response.text;

	return { status: response.status, text };
});

type Line = Omit<LaneLogLine, "judgeCost" | "time">;

const lineOf = (account: string, lane: Line["lane"], reason: Line["reason"]): Line => ({
	account,
	judgeFailures: none,
	lane,
	model: fakes.targetModel,
	reason,
	session: "lanes-1",
	substitute: false,
});

const expectedConversation = {
	baa: [
		{
			atPhi: Option.some(turns.phi.text),
			canary: true,
			headers: { "anthropic-beta": "fine-grained-tool-streaming-2025-05-14", "x-api-key": fakes.baaKey },
			model: fakes.targetModel,
		},
	],
	breaches: [],
	lines: [
		lineOf("open", "clean", "clean"),
		lineOf("baa", "sealed", "sealed new content"),
		lineOf("open", "clean", "clean"),
	],
	open: [
		{
			atPhi: Option.none(),
			canary: false,
			headers: { "anthropic-beta": beta, authorization: `Bearer ${fakes.harnessToken}` },
			model: fakes.targetModel,
		},
		{
			atPhi: Option.some(stubsFor.claude),
			canary: false,
			headers: { "anthropic-beta": beta, authorization: `Bearer ${fakes.harnessToken}` },
			model: fakes.targetModel,
		},
	],
	statuses: [status.ok, status.ok, status.ok],
};

const lanes = Effect.gen(function* lanes() {
	const { breaches, mocks, post, state } = yield* routed({ baa: noted, holdsPhi: holdsCanary });

	const statuses = yield* Effect.forEach(
		conversation,
		(sent) => Effect.map(postedIn(post, { session: "lanes-1", turns: sent }), (answer) => answer.status),
		{ concurrency: 1 },
	);

	const opened = yield* mocks.open.received;
	const sealed = yield* mocks.baa.received;
	const open = yield* Effect.forEach(opened, (sent) => viewOf(sent), { concurrency: 1 });
	const baa = yield* Effect.forEach(sealed, (sent) => viewOf(sent), { concurrency: 1 });
	const logged = yield* laneLines(state);

	const found = yield* breaches;

	const lines = pipe(logged, Array.map(Struct.omit(["judgeCost", "time"])));

	assert.deepStrictEqual<unknown>({ baa, breaches: found, lines, open, statuses }, expectedConversation);
});

const failingJudge = Effect.gen(function* failingJudge() {
	const { mocks, post, state } = yield* routed({
		holdsPhi: holdsCanary,
		judge: () => ({ kind: "status", status: 500 }),
	});

	const answer = yield* postedIn(post, { session: "lanes-2", turns: [turns.clean] });
	const opened = yield* mocks.open.received;
	const lines = yield* laneLines(state);

	const failures = pipe(
		lines,
		Array.map((line) => ({ failed: line.judgeFailures > none, lane: line.lane })),
	);

	assert.deepStrictEqual(
		{ failures, opened, status: answer.status },
		{ failures: [{ failed: true, lane: "sealed" }], opened: [], status: status.ok },
	);
});

const opaque = "BAA-OPAQUE-3J8W";

/** What a BAA account's reply can hold that no judge reads, each in a reply of its own before the reply's text. */
const opaqueBlocks = [
	{ block: { signature: "fake-signature", thinking: opaque, type: "thinking" }, name: "thinking" },
	{ block: { data: opaque, type: "redacted_thinking" }, name: "redacted thinking" },
] as const;

type Opaque = (typeof opaqueBlocks)[number];

const noteBlock = { text: "noted", type: "text" } as const;

const saying = (blocks: readonly (Opaque["block"] | typeof noteBlock)[]) => (): Said => ({
	events: Stream.fromIterable([
		{
			message: { content: [], id: "msg_baa", model: "mock", role: "assistant", type: "message" },
			type: "message_start",
		},
		...pipe(
			blocks,
			Array.flatMap((block, index) => [
				{ content_block: block, index, type: "content_block_start" },
				{ index, type: "content_block_stop" },
			]),
		),
		{ delta: { stop_reason: "end_turn" }, type: "message_delta", usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]),
	kind: "events",
});

const StoredReplyKeys = Schema.fromJsonString(Schema.Struct({ openWrote: Schema.Array(Schema.String) }));

const replyKeysIn = Effect.fnUntraced(function* replyKeysIn(state: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = path.join(state, "sessions");
	const files = yield* fs.readDirectory(folder);

	return yield* Effect.forEach(
		files,
		(file) =>
			fs.readFileString(path.join(folder, file)).pipe(
				Effect.flatMap(Schema.decodeEffect(StoredReplyKeys)),
				Effect.map(({ openWrote }) => openWrote),
			),
		{ concurrency: 1 },
	);
});

const sealedReplyKeys = Effect.fnUntraced(function* sealedReplyKeys({ block }: Opaque) {
	const baaReply = [block, noteBlock] as const;
	const { mocks, post, state } = yield* routed({ baa: saying(baaReply), holdsPhi: holdsCanary });
	const phi = { content: [{ text: turns.phi.text, type: "text" }], role: "user" };

	const first = yield* postedIn(post, { session: "lanes-5", turns: [turns.phi] });
	const kept = yield* replyKeysIn(state);

	const echoed = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))({
		max_tokens: 1024,
		messages: [
			phi,
			{ content: baaReply, role: "assistant" },
			{ content: [{ text: turns.followUp.text, type: "text" }], role: "user" },
		],
		model: "phi/auto",
		stream: true,
	});

	const next = yield* post({ body: echoed, session: "lanes-5" });
	const opened = yield* mocks.open.received;

	assert.deepStrictEqual<unknown>(
		{
			kept,
			opaqueAtOpen: pipe(
				opened,
				Array.map((sent) => Str.includes(opaque)(sent.body)),
			),
			statuses: [first.status, next.status],
		},
		{ kept: [[]], opaqueAtOpen: [false], statuses: [status.ok, status.ok] },
	);
});

const limited = '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}';

const accountErrors = Effect.gen(function* accountErrors() {
	const { mocks, post } = yield* routed({
		baa: () => ({ body: limited, kind: "status", status: status.rateLimited }),
		holdsPhi: holdsCanary,
	});

	const answer = yield* postedIn(post, { session: "lanes-3", turns: [turns.phi] });
	const open = yield* mocks.open.received;

	assert.deepStrictEqual({ answer, open }, { answer: { status: status.rateLimited, text: limited }, open: [] });
});

const noSession = Effect.gen(function* noSession() {
	const { client, mocks } = yield* routed({ holdsPhi: holdsCanary });
	const plain = yield* bodyOf([turns.clean]);
	const request = HttpClientRequest.bodyText(HttpClientRequest.post("/v1/messages"), plain, "application/json");
	const response = yield* client.execute(request);

	const received = yield* Effect.all([mocks.open.received, mocks.baa.received, mocks.judge.received], {
		concurrency: 1,
	});

	assert.deepStrictEqual({ received, status: response.status }, { received: [[], [], []], status: status.unreadable });
});

it.layer(NodeServices.layer)("the lanes over HTTP", (test) => {
	test.effect(
		"clean goes open as the harness sent it, a canary goes to the BAA account, and the follow-up carries the stub",
		() => lanes,
	);
	test.effect("a judge that fails seals the request and shows in the lane log", () => failingJudge);
	test.effect.each(opaqueBlocks)(
		"a completed BAA reply adds no reply key, and its $name never reaches the open account",
		sealedReplyKeys,
	);
	test.effect("the last BAA account's error answer passes to the harness unchanged", () => accountErrors);
	test.effect("a request with no session header gets 400, with no upstream call", () => noSession);
});
