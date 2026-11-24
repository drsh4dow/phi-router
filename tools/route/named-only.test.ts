import { Array, Effect, String as Str, Stream, Struct, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { bodyOf, routed } from "./mocked-router.ts";
import { claudeRequest, codexBodyOf, fakes, jsonText, replyMessage, userMessage } from "./harnesses.ts";
import { HttpClientRequest } from "effect/http";
import type { Json } from "./harnesses.ts";
import { NodeServices } from "@effect/platform-node";
import { capturedFirstTurn as claudeCapture } from "#router/features/anthropic-messages/index.ts";
import { capturedFirstTurn as codexCapture } from "#router/features/codex/index.ts";
import { responseEvents } from "#router/client/mock-upstreams/index.ts";
import { stubs } from "#router/features/policy/index.ts";

const canary = "PATIENT-CANARY-2H6N";

const holdsCanary = Str.includes(canary);

const status = { notFound: 404, ok: 200, unreadable: 400 } as const;

const unnamedTopLevelField = `"future_field":"${canary}"`;

interface Unnamed {
	readonly harness: "claude" | "codex";
	readonly withField: string;
}

const unnamed: readonly Unnamed[] = [
	{ harness: "claude", withField: Str.replace("{", `{${unnamedTopLevelField},`)(claudeCapture) },
	{ harness: "codex", withField: Str.replace('"stream":true', `"stream":true,${unnamedTopLevelField}`)(codexCapture) },
];

const unnamedBlock = { note: canary, type: "future_block" } as const;

const withFuture = {
	claude: jsonText({
		max_tokens: 1024,
		messages: [{ content: [unnamedBlock], role: "user" }],
		model: "phi/auto",
		stream: true,
	}),
	codex: codexBodyOf([unnamedBlock, userMessage("Go on.")]),
};

const login = { authorization: `Bearer ${fakes.harnessToken}` };

const noted = HttpClientRequest.bodyText(`{"note":"${canary}"}`, "application/json");

const unknownPaths = pipe(
	[
		noted(HttpClientRequest.post("/memories/trace_summarize")),
		noted(HttpClientRequest.post("/v1/memories/trace_summarize")),
		noted(HttpClientRequest.post("/v1/files")),
		HttpClientRequest.get("/v1/unknown"),
		noted(HttpClientRequest.post("/phi-router/unpin")),
		HttpClientRequest.get("/phi-router/sessions"),
	],
	Array.map(HttpClientRequest.setHeaders(login)),
);

const nothing = [[], [], []];

const notServed = [status.notFound, ""];

const paths = Effect.fnUntraced(function* paths({ harness }: Unnamed) {
	const { client, mocks } = yield* routed({ harness, holdsPhi: holdsCanary });

	const answers = yield* Effect.forEach(
		unknownPaths,
		(request) =>
			Effect.gen(function* answer() {
				const response = yield* client.execute(request);
				const text = yield* response.text;

				return [response.status, text];
			}),
		{ concurrency: 1 },
	);

	const received = yield* Effect.all([mocks.open.received, mocks.baa.received, mocks.judge.received], {
		concurrency: 1,
	});

	assert.deepStrictEqual<unknown>(
		{ answers, received },
		{ answers: Array.replicate(notServed, unknownPaths.length), received: nothing },
	);
});

const countTokens = Effect.gen(function* countTokens() {
	const { client, mocks } = yield* routed({ holdsPhi: holdsCanary });
	const body = yield* bodyOf([{ role: "user", text: `Member ${canary} called.` }]);
	const counted = HttpClientRequest.setUrl(claudeRequest({ body, session: "named-1" }), "/v1/messages/count_tokens");
	const response = yield* client.execute(counted);
	const text = yield* response.text;

	const received = yield* Effect.all([mocks.open.received, mocks.baa.received, mocks.judge.received], {
		concurrency: 1,
	});

	assert.deepStrictEqual<unknown>(
		{ answer: [response.status, text], received },
		{ answer: [status.notFound, ""], received: nothing },
	);
});

const unknownField = Effect.fnUntraced(function* unknownField({ harness, withField }: Unnamed) {
	const { mocks, post } = yield* routed({ harness, holdsPhi: holdsCanary });
	const response = yield* post({ body: withField, session: "named-2" });
	const text = yield* response.text;

	const received = yield* Effect.all([mocks.open.received, mocks.baa.received, mocks.judge.received], {
		concurrency: 1,
	});

	assert.deepStrictEqual<unknown>(
		{ named: Str.includes("future_field")(text), received, status: response.status, valued: holdsCanary(text) },
		{ named: true, received: nothing, status: status.unreadable, valued: false },
	);
});

const unknownBlock = Effect.fnUntraced(function* unknownBlock({ harness }: Unnamed) {
	const { mocks, post } = yield* routed({ harness, holdsPhi: holdsCanary });
	const body = yield* withFuture[harness];
	const response = yield* post({ body, session: "named-3" });

	yield* response.text;

	const opened = yield* mocks.open.received;
	const sealed = yield* mocks.baa.received;

	const judged = yield* mocks.judge.received.pipe(
		Effect.map(Array.map(({ body: asked }) => asked)),
		Effect.flatMap(jsonText),
	);

	const atOpen = pipe(
		opened,
		Array.map((sent) => ({
			block: Str.includes(unnamedBlock.type)(sent.body),
			canary: holdsCanary(sent.body),
			stub: Str.includes(stubs.unknown)(sent.body),
		})),
	);

	assert.deepStrictEqual(
		{ atOpen, judged: holdsCanary(judged), sealed, status: response.status },
		{ atOpen: [{ block: false, canary: false, stub: true }], judged: false, sealed: [], status: status.ok },
	);
});

const ok = replyMessage({ id: "msg_ok", text: "ok" });

const echoed = (part: Json): Json => ({
	content: [part],
	id: "msg_echo",
	role: "assistant",
	status: "completed",
	type: "message",
});

const canaryInUnreadParts: readonly { readonly name: string; readonly input: readonly Json[] }[] = [
	{
		input: [{ content: [{ note: canary, text: "Go on.", type: "input_text" }], role: "user", type: "message" }],
		name: "a user part with one more field",
	},
	{
		input: [
			userMessage("Hi."),
			echoed({
				annotations: [{ title: canary, type: "url_citation", url: "https://x.test" }],
				logprobs: [],
				text: "ok",
				type: "output_text",
			}),
			userMessage("Go on."),
		],
		name: "annotations that hold content",
	},
	{
		input: [
			userMessage("Hi."),
			echoed({ annotations: [], logprobs: [{ token: canary }], text: "ok", type: "output_text" }),
			userMessage("Go on."),
		],
		name: "logprobs that hold content",
	},
	{
		input: [userMessage("Hi."), ok, echoed({ refusal: canary, type: "refusal" }), userMessage("Go on.")],
		name: "a reply item whose part type the codec does not name, after one it reads",
	},
];

const atOpen = Effect.fnUntraced(function* atOpen(input: readonly Json[]) {
	const { mocks, post } = yield* routed({ harness: "codex", holdsPhi: holdsCanary });
	const body = yield* codexBodyOf(input);
	const response = yield* post({ body, session: "named-4" });

	yield* response.text;

	const opened = yield* mocks.open.received;

	const canaryAtOpen = pipe(
		opened,
		Array.map((sent) => holdsCanary(sent.body)),
	);

	assert.deepStrictEqual<unknown>(
		{ canaryAtOpen, status: response.status },
		{ canaryAtOpen: [false], status: status.ok },
	);
});

const reasoning = {
	encrypted_content: "gAAAAABopen-reasoning-blob-0001",
	id: "rs_open",
	summary: [{ text: "Plan.", type: "summary_text" }],
	type: "reasoning",
} as const;

const untouched = { blob: false, canary: false };

const summaryField = Effect.gen(function* summaryField() {
	const { mocks, post } = yield* routed({
		harness: "codex",
		holdsPhi: holdsCanary,
		open: () => ({ events: Stream.fromIterable(responseEvents([reasoning, ok])), kind: "events" }),
	});

	const first = yield* codexBodyOf([userMessage("Think.")]);
	const altered = Struct.assign(reasoning, { summary: [{ note: canary, text: "Plan.", type: "summary_text" }] });
	const next = yield* codexBodyOf([userMessage("Think."), altered, ok, userMessage("Go on.")]);

	yield* Effect.flatMap(post({ body: first, session: "named-5" }), (response) => response.text);
	yield* Effect.flatMap(post({ body: next, session: "named-5" }), (response) => response.text);

	const opened = yield* mocks.open.received;

	const atOpenEach = pipe(
		opened,
		Array.map((sent) => ({
			blob: Str.includes(reasoning.encrypted_content)(sent.body),
			canary: holdsCanary(sent.body),
		})),
	);

	assert.deepStrictEqual(atOpenEach, [untouched, untouched]);
});

it.layer(NodeServices.layer)("the router forwards only what it can name (ADR 0001)", (test) => {
	test.effect.each(unnamed)("$harness: a path the router lacks gets 404 and reaches no mock", paths);
	test.effect(
		"count_tokens gets the answer that makes Claude Code use its own estimate, and reaches no mock",
		() => countTokens,
	);
	test.effect.each(unnamed)(
		"$harness: a captured request with one more top-level field gets 400 naming it and none of its value, and reaches no mock",
		unknownField,
	);
	test.effect.each(unnamed)(
		"$harness: a block the codec cannot name reaches the open mock as the stub, and never the judge",
		unknownBlock,
	);
	test.effect.each(canaryInUnreadParts)("codex: $name reaches the open mock without it", ({ input }) => atOpen(input));
	test.effect(
		"codex: reasoning an open reply wrote, echoed with one more summary field, never reaches the open mock",
		() => summaryField,
	);
});
