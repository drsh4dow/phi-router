import { Array, Effect, Layer, Option, Record, Schema, String as Str, pipe } from "effect";
import { Headers, HttpClient, HttpClientRequest } from "effect/http";
import { NodeHttpClient, NodeHttpServer, NodeServices } from "@effect/platform-node";
import type { Said, Sent } from "#router/client/mock-upstreams/index.ts";
import { assert, it } from "@effect/vitest";
import { bodyOf, postedIn, routed } from "./mocked-router.ts";
import { codexBodyOf, codexCatalog, codexRequest, fakes, harnesses, headersNamed, userMessage } from "./harnesses.ts";
import { pinnedByModel } from "./target-models.ts";
import { serveOpenAi } from "#router/client/mock-upstreams/index.ts";

const canary = "PATIENT-CANARY-5T9V";

const holdsCanary = Str.includes(canary);

const status = {
	found: 302,
	notFound: 404,
	ok: 200,
	refused: 502,
	tooMany: 429,
	unauthorized: 401,
	unreadable: 400,
} as const;

const watchedHeaders = [
	"authorization",
	"b3",
	"chatgpt-account-id",
	"originator",
	"session-id",
	"thread-id",
	"traceparent",
	"user-agent",
	"x-client-request-id",
	"x-codex-turn-metadata",
	"x-not-carried",
	"x-openai-internal-codex-responses-lite",
];

const headersIn = Array.map(({ headers }: Sent) => headersNamed(watchedHeaders)(headers));

const namedHeaders = Effect.gen(function* namedHeaders() {
	const { mocks, post } = yield* routed({ harness: "codex", holdsPhi: holdsCanary });

	yield* postedIn(post, "wire-1", [userMessage("List the build steps.")]);
	const pinned = yield* codexBodyOf([userMessage(`Member ${canary} called.`)]);
	const answered = yield* post({ body: pinnedByModel(pinned), session: "wire-1" });

	yield* answered.text;

	const opened = yield* mocks.open.received;
	const sealed = yield* mocks.baa.received;

	assert.deepStrictEqual(
		{ baa: headersIn(sealed), open: headersIn(opened) },
		{
			baa: [{ authorization: `Bearer ${fakes.baaKey}`, "user-agent": "node" }],
			open: [
				{
					authorization: `Bearer ${fakes.harnessToken}`,
					"chatgpt-account-id": fakes.accountId,
					originator: "codex_exec",
					"session-id": "wire-1",
					"user-agent": "codex_exec/0.166.0",
					"x-openai-internal-codex-responses-lite": "true",
				},
			],
		},
	);
});

const isTrace = (name: string): boolean =>
	Array.contains(["b3", "traceparent", "tracestate"], name) || Str.startsWith("x-b3-")(name);

const judgeUntraced = Effect.gen(function* judgeUntraced() {
	const { mocks, post } = yield* routed({ harness: "codex", holdsPhi: holdsCanary });

	yield* postedIn(post, "wire-7", [userMessage(`Member ${canary} called.`)]);

	const judged = yield* mocks.judge.received;

	const traced = pipe(
		judged,
		Array.flatMap(({ headers }) => Array.filter(Record.keys(headers), isTrace)),
	);

	assert.deepStrictEqual({ judged: Array.isReadonlyArrayNonEmpty(judged), traced }, { judged: true, traced: [] });
});

const redirectTo = (location: string) => (): Said => ({ kind: "redirect", location });

const unfollowed = Effect.gen(function* unfollowed() {
	const server = yield* Layer.build(NodeHttpServer.layerTest);

	const elsewhere = yield* serveOpenAi({ catalog: redirectTo("/"), script: redirectTo("/") }).pipe(
		Effect.provideContext(server),
	);

	const { client, mocks, post } = yield* routed({
		catalog: redirectTo(`${elsewhere.endpoint}/models`),
		harness: "codex",
		holdsPhi: holdsCanary,
		open: redirectTo(`${elsewhere.endpoint}/responses`),
	});

	const sent = yield* postedIn(post, "wire-2", [userMessage("List the build steps.")]);
	const catalog = yield* client.execute(codexCatalog);
	const opened = yield* mocks.open.received;
	const reached = yield* elsewhere.received;

	assert.deepStrictEqual(
		{ opened: opened.length, reached, statuses: [sent, catalog.status] },
		{ opened: 2, reached: [], statuses: [status.found, status.found] },
	);
});

const Refusal = Schema.Struct({ message: Schema.String, type: Schema.Literal("invalid_request_error") });

const OpenAiError = Schema.fromJsonString(Schema.Struct({ error: Refusal }));

const noSession = Effect.gen(function* noSession() {
	const { client, mocks } = yield* routed({ harness: "codex", holdsPhi: holdsCanary });
	const clean = yield* codexBodyOf([userMessage("List the build steps.")]);
	const request = HttpClientRequest.bodyText(HttpClientRequest.post("/v1/responses"), clean, "application/json");
	const response = yield* client.execute(request);
	const text = yield* response.text;

	yield* Schema.decodeEffect(OpenAiError)(text, { onExcessProperty: "error" });

	const received = yield* Effect.all([mocks.open.received, mocks.baa.received, mocks.judge.received], {
		concurrency: 1,
	});

	assert.deepStrictEqual({ received, status: response.status }, { received: [[], [], []], status: status.unreadable });
});

const upgrade = Effect.gen(function* upgrade() {
	const { mocks, url } = yield* routed({ harness: "codex", holdsPhi: holdsCanary });

	const nodeHttp = yield* Layer.build(NodeHttpClient.layerNodeHttp);

	const response = yield* HttpClient.execute(
		HttpClientRequest.get(`${url}/v1/responses`).pipe(
			HttpClientRequest.setHeaders({
				connection: "Upgrade",
				"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
				"sec-websocket-version": "13",
				"session-id": "wire-4",
				upgrade: "websocket",
			}),
		),
	).pipe(Effect.provideContext(nodeHttp));

	const received = yield* Effect.all([mocks.open.received, mocks.baa.received], { concurrency: 1 });

	assert.deepStrictEqual({ received, status: response.status }, { received: [[], []], status: status.notFound });
});

const claudeOnly = Effect.gen(function* claudeOnly() {
	const { client } = yield* routed({ holdsPhi: holdsCanary });
	const body = yield* codexBodyOf([userMessage("List the build steps.")]);
	const posted = yield* client.execute(codexRequest({ body, session: "wire-5" }));
	const listed = yield* client.execute(codexCatalog);

	assert.deepStrictEqual([posted.status, listed.status], [status.notFound, status.notFound]);
});

const codexOnly = Effect.gen(function* codexOnly() {
	const { client, mocks } = yield* routed({ harness: "codex", holdsPhi: holdsCanary });
	const body = yield* bodyOf([{ role: "user", text: "List the build steps." }]);

	const statuses = yield* Effect.forEach(
		[harnesses.claude, harnesses.pi],
		(harness) => Effect.map(client.execute(harness.request({ body, session: "wire-7" })), (answer) => answer.status),
		{ concurrency: 1 },
	);

	const reached = yield* mocks.accounts;

	assert.deepStrictEqual({ reached, statuses }, { reached: [[], []], statuses: [status.notFound, status.notFound] });
});

const answeredHeaders = {
	"openai-organization": "org-not-carried",
	"retry-after": "3",
	"set-cookie": "account=not-carried",
	"x-not-carried": "1",
	"x-request-id": "req_wire",
};

const limited = (): Said => ({ body: "{}", headers: answeredHeaders, kind: "status", status: status.tooMany });

const returnedHeaders = Effect.gen(function* returnedHeaders() {
	const { post } = yield* routed({ baa: limited, harness: "codex", holdsPhi: holdsCanary, open: limited });
	const body = yield* codexBodyOf([userMessage("List the build steps.")]);
	const response = yield* post({ body, session: "wire-6" });

	const returned = pipe(
		["content-type", ...Record.keys(answeredHeaders)],
		Array.filter((name) => Option.isSome(Headers.get(response.headers, name))),
	);

	assert.deepStrictEqual(returned, ["content-type", "retry-after", "x-request-id"]);
});

it.layer(NodeServices.layer)("Codex's wire", (test) => {
	test.effect(
		"the open account gets the six named headers and the BAA account its key alone for a pinned request, with no trace header",
		() => namedHeaders,
	);
	test.effect("the judge gets no trace header", () => judgeUntraced);
	test.effect("an account's redirect reaches the harness and is never followed", () => unfollowed);
	test.effect("no session-id gets 400 in OpenAI's shape, with no upstream call", () => noSession);
	test.effect("a WebSocket upgrade gets 404 and reaches no account", () => upgrade);
	test.effect("a router with no OpenAI account answers 404 on Codex's paths", () => claudeOnly);
	test.effect(
		"a router with no Anthropic account answers 404 on Claude Code's and pi's paths and reaches no account",
		() => codexOnly,
	);
	test.effect(
		"Codex gets back only content-type, x-request-id and retry-after of an account's headers",
		() => returnedHeaders,
	);
});
