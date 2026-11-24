import { Array, Effect, Exit, Layer, Schema, String as Str, Struct, pipe } from "effect";
import type { Post, Turn } from "./mocked-router.ts";
import { assert, it } from "@effect/vitest";
import { bodyOf, fakes, laneLines, routed } from "./mocked-router.ts";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import { SessionRequests } from "#router/client/router-port/index.ts";
import type { VerdictStore } from "#router/client/verdict-store.ts";

const asked = {
	first: "PIN-FIRST: list the build steps.",
	last: "PIN-LAST: and the release.",
	second: "PIN-SECOND: now the tests.",
};

const replies = { first: "PIN-REPLY-ONE", second: "PIN-REPLY-TWO" };

const user = (text: string): Turn => ({ role: "user", text });

const assistant = (text: string): Turn => ({ role: "assistant", text });

const whilePinned: readonly (readonly Turn[])[] = [
	[user(asked.first)],
	[user(asked.first), assistant(replies.first), user(asked.second)],
];

/** The marked part of each turn of `afterUnpin`. */
const marked = [asked.first, replies.first, asked.second, replies.second, asked.last];

const none = 0;

const afterUnpin: readonly Turn[] = [
	user(asked.first),
	assistant(replies.first),
	user(asked.second),
	assistant(replies.second),
	user(asked.last),
];

/** Posts `turns` as one Claude Code request of `session` and reads the whole answer. */
const postedIn = Effect.fnUntraced(function* postedIn(post: Post, session: string, turns: readonly Turn[]) {
	const body = yield* bodyOf(turns);
	const response = yield* post({ body, session });

	yield* response.text;

	return response.status;
});

const jsonText = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** The marked texts the judge mock was asked about in `received`, in the order of `texts`. */
const judgedOf = Effect.fnUntraced(function* judgedOf(
	received: readonly { readonly body: unknown }[],
	texts: readonly string[],
) {
	const bodies = yield* Effect.forEach(received, ({ body }) => jsonText(body), { concurrency: 1 });

	return pipe(
		texts,
		Array.filter((text) =>
			pipe(
				bodies,
				Array.some((sent) => Str.includes(text)(sent)),
			),
		),
	);
});

/** A Claude Code body with no system blocks still has one system part, which clears as empty with no judge call. */
const systemPart = 1;

const session = "pin-1";

const onePart = 1;

const portOf = (url: string): number => Number(new URL(url).port);

/** Sets the pin of session `pin-1` on the router at `url`, as `pin` and `unpin` do. */
const pinnedOn = Effect.fnUntraced(function* pinnedOn(url: string, pinned: boolean) {
	const requests = yield* SessionRequests;

	yield* requests.pin(portOf(url), { pinned, session });
});

/** The status of session `of` the router at `url` reports, as `status` prints it. */
const statusOn = Effect.fnUntraced(function* statusOn(url: string, of: string) {
	const requests = yield* SessionRequests;
	const status = yield* requests.status(portOf(url), of);

	return Struct.assign(status, { session: String(status.session) });
});

type Shown = Effect.Success<ReturnType<typeof statusOn>>;

/**
 * `pin`, the two requests of `whilePinned`, `unpin` and the request of `afterUnpin`, all of one session. Returns what
 * the judge mock, the lane log and `status` show while pinned and at the end.
 */
const pinnedThenUnpinned = Effect.gen(function* pinnedThenUnpinned() {
	const { mocks, post, state, url } = yield* routed({ holdsPhi: () => false });

	yield* pinnedOn(url, true);
	yield* Effect.forEach(whilePinned, (turns) => postedIn(post, session, turns), { concurrency: 1 });

	const whilePinnedSeen = {
		judged: yield* mocks.judge.received,
		status: yield* statusOn(url, session),
	};

	yield* pinnedOn(url, false);
	yield* postedIn(post, session, afterUnpin);

	const judged = yield* mocks.judge.received;
	const lines = yield* laneLines(state);

	return {
		judged: { asked: yield* judgedOf(judged, marked), calls: judged.length },
		lines: pipe(
			lines,
			Array.map(({ account, judgeCost, lane, reason }) => [account, lane, reason, judgeCost > none]),
		),
		status: yield* statusOn(url, session),
		whilePinned: { judged: whilePinnedSeen.judged.length, status: whilePinnedSeen.status },
	};
});

/**
 * The status of session `pin-1`.
 *
 * @param {object} seen How many parts are cleared, the pin, and the account of the last request.
 * @returns {Shown} The status.
 */
const statusOf = (seen: { readonly cleared: number; readonly pinned: boolean; readonly account: string }): Shown => ({
	accounts: { clean: [{ name: "open", vendor: "anthropic" }], sealed: [{ name: "baa", vendor: "anthropic" }] },
	cleared: seen.cleared,
	last: { account: seen.account, model: fakes.targetModel, substitute: false },
	pinned: seen.pinned,
	sealed: none,
	session,
});

const pinnedStretch = Effect.gen(function* pinnedStretch() {
	const seen = yield* pinnedThenUnpinned;

	assert.deepStrictEqual(seen, {
		judged: { asked: marked, calls: marked.length },
		lines: [
			["baa", "sealed", "pinned", false],
			["baa", "sealed", "pinned", false],
			["open", "clean", "clean", true],
		],
		status: statusOf({ account: "open", cleared: marked.length + systemPart, pinned: false }),
		whilePinned: { judged: none, status: statusOf({ account: "baa", cleared: none, pinned: true }) },
	});
});

/**
 * The verdict store, but every read after the first unpins the session before it reads, as an `unpin` does that lands
 * between the first request's arrival and its send.
 *
 * @param {object} real The router's verdict store.
 * @returns {object} The store with that read.
 */
const unpinnedBeforeTheSend = (real: VerdictStore["Service"]): VerdictStore["Service"] => {
	const reads = { arrived: false };

	const read: typeof real.read = (pinned, policy) => {
		if (reads.arrived) {
			return Effect.andThen(real.pin(pinned, policy, false), real.read(pinned, policy));
		}

		reads.arrived = true;

		return real.read(pinned, policy);
	};

	return Struct.assign(real, { read });
};

/** A request that arrives pinned, whose session is unpinned before its send, then the next request of the session. */
const lateUnpin = Effect.gen(function* lateUnpin() {
	const { mocks, post, state, url } = yield* routed({ holdsPhi: () => false, store: unpinnedBeforeTheSend });

	yield* pinnedOn(url, true);
	yield* postedIn(post, session, [user(asked.first)]);

	const inFlight = { baa: (yield* mocks.baa.received).length, judged: (yield* mocks.judge.received).length };

	yield* postedIn(post, session, [user(asked.first), assistant(replies.first), user(asked.second)]);

	const lines = yield* laneLines(state);

	assert.deepStrictEqual<unknown>(
		{
			inFlight,
			lines: pipe(
				lines,
				Array.map(({ account, reason }) => [account, reason]),
			),
			open: (yield* mocks.open.received).length,
			pinned: (yield* statusOn(url, session)).pinned,
		},
		{
			inFlight: { baa: 1, judged: none },
			lines: [
				["baa", "pinned"],
				["open", "clean"],
			],
			open: 1,
			pinned: false,
		},
	);
});

/** Looks like an SSN, so the rules seal it unless the configuration lists it. */
const listed = "Fixture patient, SSN 536-22-8726.";

const fixtures = Effect.gen(function* fixtures() {
	const { mocks, post, state, url } = yield* routed({ configured: { fixtures: [listed] }, holdsPhi: () => false });

	yield* postedIn(post, "fixture-1", [user(listed)]);
	yield* postedIn(post, "fixture-2", [user(`${listed} `)]);
	yield* postedIn(post, "fixture-3", [user(Str.uncapitalize(listed))]);

	const judged = yield* mocks.judge.received;
	const lines = yield* laneLines(state);
	const counted = yield* Effect.forEach(["fixture-1", "fixture-2"], (of) => statusOn(url, of), { concurrency: 1 });

	const counts = pipe(
		counted,
		Array.map(({ cleared, sealed }) => ({ cleared, sealed })),
	);

	assert.deepStrictEqual(
		{
			counts,
			judged: judged.length,
			lines: pipe(
				lines,
				Array.map(({ account, reason }) => [account, reason]),
			),
		},
		{
			counts: [
				{ cleared: systemPart + onePart, sealed: none },
				{ cleared: systemPart, sealed: onePart },
			],
			judged: 0,
			lines: [
				["open", "clean"],
				["baa", "sealed new content"],
				["baa", "sealed new content"],
			],
		},
	);
});

const modes = Effect.gen(function* modes() {
	const built = yield* Effect.forEach(
		[{ mode: "shadow" }, { mode: "baa" }, { mode: false }, {}],
		(configured) => Effect.exit(Effect.scoped(routed({ configured, holdsPhi: () => false }))),
		{ concurrency: 1 },
	);

	assert.deepStrictEqual(
		pipe(
			built,
			Array.map((exit) => Exit.isSuccess(exit)),
		),
		[false, false, false, true],
	);
});

it.layer(Layer.mergeAll(NodeServices.layer, SessionRequests.layer, FetchHttpClient.layer))(
	"pin and fixtures",
	(test) => {
		test.effect(
			"a pinned session runs on the BAA account with nothing judged, and after unpin the next request judges the pinned stretch",
			() => pinnedStretch,
		);
		test.effect(
			"a listed fixture clears with no rule and no judge call, and the same text with one more space or one letter's case changed seals",
			() => fixtures,
		);
		test.effect(
			"a request pinned on arrival runs on the BAA account with nothing judged when the unpin lands before its send",
			() => lateUnpin,
		);
		test.effect("the configuration refuses a mode key, whatever its value", () => modes);
	},
);
