import { Array, Effect, Schema, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { codexBodyOf, userMessage } from "./harnesses.ts";
import { NodeServices } from "@effect/platform-node";
import type { Sent } from "#router/client/mock-upstreams/index.ts";
import { routed } from "./mocked-router.ts";

const canary = "PATIENT-CANARY-6J3W";

const folder = "/home/someone/work/billing";

const remote = "https://github.com/example/billing.git";

const id = "00000000-0000-7000-8000-000000000001";

const turnMetadataInGit = `{"session_id":"${id}","workspaces":{"${folder}":{"associated_remote_urls":{"origin":"${remote}"},"latest_git_commit_hash":"999fe40","has_changes":false}},"sandbox_mode":"read-only"}`;

const turnMetadataOutsideGit = `{"session_id":"${id}","sandbox_mode":"read-only"}`;

const codexBodyOpening = '{"model":"phi/auto"';

const ClientMetadata = Schema.fromJsonString(Schema.Struct({ "x-codex-turn-metadata": Schema.String }));

const SentMetadata = Schema.fromJsonString(
	Schema.Struct({ client_metadata: Schema.Struct({ "x-codex-turn-metadata": Schema.String }) }),
);

const bodyInGit = Effect.fnUntraced(function* bodyInGit(text: string) {
	const body = yield* codexBodyOf([userMessage(text)]);
	const metadata = yield* Schema.encodeEffect(ClientMetadata)({ "x-codex-turn-metadata": turnMetadataInGit });

	return Str.replace('"include":', `"client_metadata":${metadata},"include":`)(body);
});

const carried = (
	sent: readonly Sent[],
): Effect.Effect<readonly { readonly turn: string; readonly named: boolean }[], Schema.SchemaError> =>
	Effect.forEach(
		sent,
		({ body }) =>
			Effect.map(Schema.decodeEffect(SentMetadata)(body), ({ client_metadata: metadata }) => ({
				named: Str.includes(folder)(body) || Str.includes(remote)(body),
				turn: metadata["x-codex-turn-metadata"],
			})),
		{ concurrency: 1 },
	);

const workspaces = Effect.gen(function* workspaces() {
	const { mocks, post } = yield* routed({ harness: "codex", holdsPhi: Str.includes(canary) });
	const clean = yield* bodyInGit("List the build steps.");
	const sealed = yield* bodyInGit(`Member ${canary} called.`);

	yield* Effect.forEach(
		[
			{ body: clean, session: "workspaces-1" },
			{ body: sealed, session: "workspaces-2" },
		],
		(request) => Effect.flatMap(post(request), (response) => response.text),
		{ concurrency: 1 },
	);

	const open = yield* mocks.open.received;
	const baa = yield* mocks.baa.received;
	const opened = yield* carried(open);
	const sealedTurns = yield* carried(baa);

	assert.deepStrictEqual(
		{
			baa: sealedTurns,
			open: opened,
			sealedBytes: pipe(
				baa,
				Array.map((sent) => Str.includes(Str.slice(codexBodyOpening.length)(sealed))(sent.body)),
			),
		},
		{
			baa: [{ named: true, turn: turnMetadataInGit }],
			open: [{ named: false, turn: turnMetadataOutsideGit }],
			sealedBytes: [true],
		},
	);
});

it.layer(NodeServices.layer)("a Codex request from a git folder", (test) => {
	test.effect(
		"goes open with its workspaces dropped from the turn metadata, and sealed with them as sent",
		() => workspaces,
	);
});
