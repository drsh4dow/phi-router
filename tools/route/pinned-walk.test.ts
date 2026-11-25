import { Array, Effect, FileSystem, Stream, Struct, pipe } from "effect";
import type { Said, Sent } from "#router/client/mock-upstreams/index.ts";
import { assert, it } from "@effect/vitest";
import { autoOf, clean, leased, posted } from "./target-models.ts";
import { laneLines, routed } from "./mocked-router.ts";
import type { LaneLogLine } from "./mocked-router.ts";
import { NodeServices } from "@effect/platform-node";
import { pinnedModel } from "#router/features/lanes/index.ts";
import { textEvents } from "#router/client/mock-upstreams/index.ts";

const once = 1;

const failing = (): Said => ({ body: "{}", kind: "status", status: 500 });

const ok = (): Said => ({ events: Stream.fromIterable(textEvents(["ok"])), kind: "events" });

const failingFirst = { baas: [failing, ok], holdsPhi: () => false } as const;

const onlyBaa = {
	lines: [["baa-2", "sealed", "failover"]],
	received: { baa: [once, once], open: 0 },
	status: 200,
};

interface Seen {
	readonly lines: readonly (readonly string[])[];
	readonly received: { readonly baa: readonly number[]; readonly open: number };
}

const seenIn = (received: readonly (readonly Sent[])[], lines: readonly LaneLogLine[]): Seen => {
	const [open = [], ...baas] = received;

	return {
		lines: pipe(
			lines,
			Array.map(({ account, lane, reason }) => [account, lane, reason]),
		),
		received: {
			baa: pipe(
				baas,
				Array.map((sent) => sent.length),
			),
			open: open.length,
		},
	};
};

const pinned = Effect.gen(function* pinned() {
	const run = yield* routed(failingFirst);
	const status = yield* posted(run.post, { harness: "claude", model: pinnedModel, session: "pinned-walk-1" }, [clean]);
	const received = yield* run.mocks.accounts;
	const lines = yield* laneLines(run.state);
	const [, atFirst = [], atSecond = []] = received;

	const bodies = pipe(
		[...atFirst, ...atSecond],
		Array.map((sent) => sent.body),
		Array.dedupe,
	);

	assert.deepStrictEqual(
		Struct.assign(seenIn(received, lines), { bodies: bodies.length, status }),
		Struct.assign(onlyBaa, { bodies: once }),
	);
});

const inRepo = Effect.gen(function* inRepo() {
	const fs = yield* FileSystem.FileSystem;
	const repo = yield* Effect.flatMap(fs.makeTempDirectoryScoped({ prefix: "phi-router-repo-" }), fs.realPath);
	const session = "repo-walk-1";
	const run = yield* routed(Struct.assign(failingFirst, { configExtras: { baaRepos: [repo] } }));

	yield* leased(run.state, session, repo);

	const status = yield* posted(run.post, { harness: "claude", model: autoOf.claude, session }, [clean]);
	const received = yield* run.mocks.accounts;
	const lines = yield* laneLines(run.state);

	assert.deepStrictEqual(Struct.assign(seenIn(received, lines), { status }), onlyBaa);
});

it.layer(NodeServices.layer)("a held request whose first BAA account fails", (test) => {
	test.effect("moves to the next BAA account and never to an open one, with the same pinned body", () => pinned);
	test.effect("of a BAA repo moves to the next BAA account and never to an open one", () => inRepo);
});
