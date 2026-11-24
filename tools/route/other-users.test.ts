import { Array, Context, Effect, FileSystem, Layer, Schema, String as Str } from "effect";
import { assert, it } from "@effect/vitest";
import { bodyOf, postedIn, routed } from "./mocked-router.ts";
import { Callers } from "#router/client/router-port/index.ts";
import { HttpClientRequest } from "effect/http";
import { NodeServices } from "@effect/platform-node";

const canary = "PATIENT-CANARY-7Q4K";

const holdsCanary = Str.includes(canary);

const status = { forbidden: 403, ok: 200 } as const;

const refusedRequests = 6;

const anotherUser = Callers.of({ isThisUser: () => Effect.succeed(false) });

const lease = HttpClientRequest.bodyText(HttpClientRequest.post("/phi-router/leases"), "{}", "application/json");

const hello = HttpClientRequest.get("/api/hello");

const unrouted = HttpClientRequest.get("/phi-router/no-such-row");

const pinned = HttpClientRequest.bodyText(
	HttpClientRequest.post("/phi-router/pin"),
	'{"session":"other-1","pinned":true}',
	"application/json",
);

const asked = HttpClientRequest.get("/phi-router/status?session=other-1");

const catalog = HttpClientRequest.get("/v1/models?client_version=0.166.0");

const said = [{ content: [{ text: "hi", type: "input_text" }], role: "user", type: "message" }];

const claudeRefused = Effect.gen(function* claudeRefused() {
	const { client, mocks, post } = yield* routed({ callers: anotherUser, holdsPhi: holdsCanary });
	const body = yield* bodyOf([{ role: "user", text: `Member ${canary} called.` }]);

	const statuses = yield* Effect.forEach(
		[
			post({ body, session: "other-1" }),
			client.execute(lease),
			client.execute(hello),
			client.execute(pinned),
			client.execute(asked),
			client.execute(unrouted),
		],
		(answered) => answered.pipe(Effect.flatMap((response) => Effect.as(response.text, response.status))),
		{ concurrency: 1 },
	);

	const received = yield* Effect.all([mocks.open.received, mocks.baa.received, mocks.judge.received], {
		concurrency: 1,
	});

	assert.deepStrictEqual(
		{ received, statuses },
		{
			received: [[], [], []],
			statuses: Array.replicate(status.forbidden, refusedRequests),
		},
	);
});

const codexRefused = Effect.gen(function* codexRefused() {
	const { client, mocks, post } = yield* routed({ callers: anotherUser, harness: "codex", holdsPhi: () => false });
	const responses = yield* postedIn(post, "other-2", said);
	const models = yield* client.execute(catalog);

	yield* models.text;

	const received = yield* Effect.all([mocks.open.received, mocks.baa.received, mocks.judge.received], {
		concurrency: 1,
	});

	assert.deepStrictEqual(
		{ received, statuses: [responses, models.status] },
		{ received: [[], [], []], statuses: [status.forbidden, status.forbidden] },
	);
});

const thisUserServed = Effect.gen(function* thisUserServed() {
	const { mocks, post } = yield* routed({ holdsPhi: holdsCanary });
	const body = yield* bodyOf([{ role: "user", text: `Member ${canary} called.` }]);
	const answer = yield* post({ body, session: "other-3" });

	yield* answer.text;

	const sealed = yield* mocks.baa.received;

	assert.deepStrictEqual({ answered: answer.status, sealed: sealed.length }, { answered: status.ok, sealed: 1 });
});

const lsofServed = Effect.gen(function* lsofServed() {
	const noProcTable = FileSystem.layerNoop({ exists: () => Effect.succeed(false) });
	const built = yield* Layer.build(Callers.layer.pipe(Layer.provide(noProcTable)));
	const { mocks, post } = yield* routed({ callers: Context.get(built, Callers), holdsPhi: () => false });
	const body = yield* bodyOf([{ role: "user", text: "List the build steps." }]);
	const answer = yield* post({ body, session: "other-4" });

	yield* answer.text;

	const open = yield* mocks.open.received;

	assert.deepStrictEqual({ answered: answer.status, open: open.length }, { answered: status.ok, open: 1 });
});

const Refusal = Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }));

const toldWhy = Effect.gen(function* toldWhy() {
	const { client } = yield* routed({ callers: anotherUser, holdsPhi: holdsCanary });
	const response = yield* client.execute(hello);
	const text = yield* response.text;
	const refusal = yield* Schema.decodeEffect(Refusal)(text);

	assert.strictEqual(refusal.error.message, "phi-router answers only the user who runs it");
});

it.layer(NodeServices.layer)("a caller of another user", (test) => {
	test.effect(
		"gets 403 on the Claude path, the lease path, every other and a path the table lacks, and no mock or judge receives anything",
		() => claudeRefused,
	);
	test.effect("gets 403 on the Codex paths, and no mock or judge receives anything", () => codexRefused);
	test.effect(
		"is told apart from this user, whose same request the real caller check lets through to the BAA mock",
		() => thisUserServed,
	);
	test.effect(
		"is told apart by lsof where there is no /proc/net/tcp, as on macOS, and this user is served",
		() => lsofServed,
	);
	test.effect("is told why in error.message, the field Claude Code and Codex print", () => toldWhy);
});
