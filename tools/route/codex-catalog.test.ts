import { Array, Effect, Option, Schema, String as Str, Struct, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { fakes, headersNamed } from "./harnesses.ts";
import { HttpClientRequest } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import type { Said } from "#router/client/mock-upstreams/index.ts";
import { routed } from "./mocked-router.ts";

const status = { notFound: 404, ok: 200, refused: 502, unauthorized: 401, unreadable: 400 } as const;

const Entry = Schema.Struct({
	context_window: Schema.optionalKey(Schema.Finite),
	display_name: Schema.optionalKey(Schema.String),
	slug: Schema.String,
	upgrade: Schema.optionalKey(Schema.OptionFromNullOr(Schema.String)),
	visibility: Schema.String,
});

const Catalog = Schema.fromJsonString(Schema.Struct({ models: Schema.Array(Entry) }));

/** Codex's catalog request as 0.166.0 sends it, with a query parameter and a header no account may get. */
const asked = HttpClientRequest.get("/v1/models?client_version=0.166.0&debug=1").pipe(
	HttpClientRequest.setHeaders({
		authorization: `Bearer ${fakes.harnessToken}`,
		"chatgpt-account-id": fakes.accountId,
		originator: "codex_exec",
		"user-agent": "codex_exec/0.166.0",
		"x-not-carried": "1",
	}),
);

const shown = ["authorization", "chatgpt-account-id", "originator", "user-agent", "x-not-carried"];

const target = { context_window: 272_000, display_name: "Target", slug: fakes.targetModel, visibility: "hide" };

const expectedList = {
	models: [
		{ slug: "other-model", visibility: "list" },
		Struct.assign(target, { upgrade: Option.some("newer-model") }),
		Struct.assign(target, { display_name: "PHI auto", slug: "phi/auto", upgrade: Option.none(), visibility: "list" }),
	],
	sealed: [],
	seen: [
		{
			headers: {
				authorization: `Bearer ${fakes.harnessToken}`,
				"chatgpt-account-id": fakes.accountId,
				originator: "codex_exec",
				"user-agent": "codex_exec/0.166.0",
			},
			method: "GET",
			path: "/models",
			query: "client_version=0.166.0",
		},
	],
	status: status.ok,
};

const listed = Effect.gen(function* listed() {
	const { client, mocks } = yield* routed({ harness: "codex", holdsPhi: () => false });
	const response = yield* client.execute(asked);
	const { models } = yield* response.text.pipe(Effect.flatMap(Schema.decodeEffect(Catalog)));
	const opened = yield* mocks.open.received;
	const sealed = yield* mocks.baa.received;

	const seen = pipe(
		opened,
		Array.map(({ headers, method, path, query }) => ({
			headers: headersNamed(shown)(headers),
			method,
			path,
			query,
		})),
	);

	assert.deepStrictEqual<unknown>({ models, sealed, seen, status: response.status }, expectedList);
});

const expired = '{"error":{"message":"token expired"}}';

/** What the harness gets when the open account's catalog answers `body` with `answered`. */
const answeredWith = Effect.fnUntraced(function* answeredWith(answered: number, body: string) {
	const said: Said = { body, kind: "status", status: answered };
	const { client } = yield* routed({ catalog: () => said, harness: "codex", holdsPhi: () => false });
	const response = yield* client.execute(asked);
	const text = yield* response.text;

	return { status: response.status, text };
});

const relayed = Effect.gen(function* relayed() {
	const refused = yield* answeredWith(status.unauthorized, expired);
	const missing = yield* answeredWith(status.ok, '{"models":[{"slug":"other-model"}]}');

	assert.deepStrictEqual(
		{ missing: [missing.status, Str.includes(fakes.targetModel)(missing.text)], refused },
		{ missing: [status.refused, true], refused: { status: status.unauthorized, text: expired } },
	);
});

/** Claude Code 2.1.325's model discovery, as it reached a listener on 2026-11-21: no `originator`. */
const discovery = HttpClientRequest.get("/v1/models?limit=1000").pipe(
	HttpClientRequest.setHeaders({
		accept: "application/json",
		"anthropic-version": "2023-06-01",
		authorization: `Bearer ${fakes.harnessToken}`,
		"user-agent": "claude-code/2.1.325",
	}),
);

const notCodex = Effect.gen(function* notCodex() {
	const { client, mocks } = yield* routed({ harness: "codex", holdsPhi: () => false });
	const discovered = yield* client.execute(discovery);
	const discoveredBody = yield* discovered.text;
	const accounts = [mocks.open.received, mocks.baa.received, mocks.judge.received];
	const reached = yield* Effect.all(accounts, { concurrency: 1 });

	assert.deepStrictEqual<unknown>(
		{ discovered: [discovered.status, discoveredBody], reached },
		{ discovered: [status.notFound, ""], reached: [[], [], []] },
	);
});

const codexHeaders = {
	authorization: `Bearer ${fakes.harnessToken}`,
	"chatgpt-account-id": fakes.accountId,
	originator: "codex_exec",
};

const canary = "8A73DG5RM60";

/** Digits and dots alone, one character over the 32 a version may take. */
const longVersion = "0.166.0.0.0.0.0.0.0.0.0.0.0.0.0.0";

/** What reaches the open account, and what the harness gets, for each `client_version`. */
const versioned = Effect.gen(function* versioned() {
	const { client, mocks } = yield* routed({ harness: "codex", holdsPhi: () => false });

	const statuses = yield* Effect.forEach(
		[canary, `0.166.0-${canary}`, longVersion, "0.43.0-alpha.4", "0.166.0"],
		(version) =>
			client
				.execute(
					HttpClientRequest.get("/v1/models").pipe(
						HttpClientRequest.setUrlParam("client_version", version),
						HttpClientRequest.setHeaders(codexHeaders),
					),
				)
				.pipe(
					Effect.tap((response) => response.text),
					Effect.map((response) => response.status),
				),
		{ concurrency: 1 },
	);

	const opened = yield* mocks.open.received;
	const sealed = yield* mocks.baa.received;

	assert.deepStrictEqual<unknown>(
		{
			queries: pipe(
				opened,
				Array.map(({ query }) => query),
			),
			sealed,
			statuses,
		},
		{
			queries: ["client_version=0.43.0-alpha.4", "client_version=0.166.0"],
			sealed: [],
			statuses: [status.unreadable, status.unreadable, status.unreadable, status.ok, status.ok],
		},
	);
});

it.layer(NodeServices.layer)("Codex's model catalog", (test) => {
	test.effect(
		"a client_version without the shape of a version gets 400 and reaches no account, and a release or pre-release passes",
		() => versioned,
	);
	test.effect(
		"lists phi/auto beside the open account's models, asked with the forwarded login and client_version alone",
		() => listed,
	);
	test.effect("an account's error passes as it came, and a catalog with no target model gets 502", () => relayed);
	test.effect(
		"a model list asked with no Codex originator gets the 404 of a path the router lacks, and reaches no account",
		() => notCodex,
	);
});
