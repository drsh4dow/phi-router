import { Array, Effect, FileSystem, Stream, Struct, pipe } from "effect";
import type { LaneLogLine, Post } from "./mocked-router.ts";
import type { Said, Sent } from "#router/client/mock-accounts.ts";
import { assert, it } from "@effect/vitest";
import { bodyOf, laneLines, routed } from "./mocked-router.ts";
import { NodeServices } from "@effect/platform-node";
import type { VerdictStore } from "#router/client/verdict-store.ts";
import { leased } from "./target-models.ts";
import { textEvents } from "#router/client/mock-accounts.ts";

const once = 1;

const failing = (): Said => ({ body: "{}", kind: "status", status: 500 });

const ok = (): Said => ({ events: Stream.fromIterable(textEvents(["ok"])), kind: "events" });

/** One open account, a first BAA account that answers 500, and a second that answers. */
const failingFirst = { baas: [failing, ok], holdsPhi: () => false } as const;

/** The request reaches the second BAA account alone, and its one lane log line names it for failover. */
const onlyBaa = {
	lines: [["baa-2", "sealed", "failover"]],
	received: { baa: [once, once], open: 0 },
	status: 200,
};

/** A first BAA account's script, and how the verdict store the router reads is wrapped. */
interface Unpinning {
	readonly first: () => Said;
	readonly store: (real: VerdictStore["Service"]) => VerdictStore["Service"];
}

/**
 * A first BAA account that answers 500, and a verdict store that holds the session pinned until that account has
 * answered and unpinned from then on, as an `unpin` does that lands between the request's first and second send.
 *
 * @returns {Unpinning} The account's script and the store.
 */
const unpinnedAfterTheFirstSend = (): Unpinning => {
	const answered = { yet: false };

	const first = (): Said => {
		answered.yet = true;

		return failing();
	};

	const store = (real: VerdictStore["Service"]): VerdictStore["Service"] =>
		Struct.assign(real, {
			read: (session: string, policy: string) =>
				Effect.andThen(real.pin(session, policy, !answered.yet), real.read(session, policy)),
		});

	return { first, store };
};

/** Posts one request of `session`, reads the whole answer, and returns its status. */
const asked = Effect.fnUntraced(function* asked(post: Post, session: string) {
	const body = yield* bodyOf([{ role: "user", text: "List the build steps." }]);
	const response = yield* post({ body, session });

	yield* response.text;

	return response.status;
});

/** What the accounts received and the lane log holds, as `onlyBaa` names them. */
interface Seen {
	readonly lines: readonly (readonly string[])[];
	readonly received: { readonly baa: readonly number[]; readonly open: number };
}

/**
 * What the accounts received and the lane log holds, as `onlyBaa` names them.
 *
 * @param {readonly (readonly Sent[])[]} received What each account received, the open one first.
 * @param {readonly LaneLogLine[]} lines The lane log's lines.
 * @returns {Seen} The open account's count, each BAA account's, and each line's account, lane and reason.
 */
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
	const { first, store } = unpinnedAfterTheFirstSend();
	const run = yield* routed({ baas: [first, ok], holdsPhi: () => false, store });

	const status = yield* asked(run.post, "pinned-walk-1");
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
	const run = yield* routed(Struct.assign(failingFirst, { configured: { baaRepos: [repo] } }));

	yield* leased(run.state, session, repo);

	const status = yield* asked(run.post, session);
	const received = yield* run.mocks.accounts;
	const lines = yield* laneLines(run.state);

	assert.deepStrictEqual(Struct.assign(seenIn(received, lines), { status }), onlyBaa);
});

it.layer(NodeServices.layer)("a held request whose first BAA account fails", (test) => {
	test.effect(
		"moves to the next BAA account and never to an open one, with the same pinned body, though an unpin lands between the two sends",
		() => pinned,
	);
	test.effect("of a BAA repo moves to the next BAA account and never to an open one", () => inRepo);
});
