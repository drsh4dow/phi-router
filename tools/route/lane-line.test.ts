import { Array, Effect, Fiber, FileSystem, Path, Schedule, Schema, Stream, Struct, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { bodyOf, laneLines, routed } from "./mocked-router.ts";
import type { AccountScript } from "./harnesses.ts";
import { NodeServices } from "@effect/platform-node";
import { TestClock } from "effect/testing";
import type { VerdictStore } from "#router/client/verdict-store.ts";
import { homeOf } from "#router/features/accounts/index.ts";
import { silent } from "./resetting.ts";
import { textEvents } from "#router/client/mock-upstreams/index.ts";

const badGateway = 502;

const failed = 500;

const day = 86_400_000;

const twoAccounts = 2;

const tries = 100;

const homeIndex = 0;

const endedLogin = Effect.gen(function* endedLogin() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-ended-" });
	const before = -day;

	yield* fs.writeFileString(
		path.join(folder, ".credentials.json"),
		`{"claudeAiOauth":{"accessToken":"phi-test-claude-token-ended","expiresAt":${String(before)},"refreshTokenExpiresAt":${String(before)}}}`,
	);

	return folder;
});

const linesIn = Effect.fnUntraced(function* linesIn(state: string) {
	const lines = yield* laneLines(state);

	return pipe(
		lines,
		Array.map(({ account, lane, reason }) => [account, lane, reason]),
	);
});

const answers: AccountScript = () => ({ events: Stream.fromIterable(textEvents(["ok"])), kind: "events" });

const failing: AccountScript = () => ({ body: "{}", kind: "status", status: 500 });

/** The router writes the line as it lets go of a request the harness hung up on, so the test waits for it. */
const lineRetry = { schedule: Schedule.spaced("20 millis") } as const;

/**
 * The open account answers 500, the BAA account takes the request and never answers, and the harness hangs up while
 * it waits. The request still leaves its one line, naming the BAA account it was last sent to.
 */
const hungUp = Effect.gen(function* hungUp() {
	const quiet = yield* silent;

	const { mocks, post, state } = yield* routed({
		baas: [{ endpoint: quiet.endpoint }],
		holdsPhi: () => false,
		open: failing,
	});

	const body = yield* bodyOf([{ role: "user", text: "Go on." }]);
	const request = yield* Effect.forkChild(post({ body, session: "hang-up-1" }));

	yield* quiet.arrived.await;
	yield* Fiber.interrupt(request);

	const lines = yield* laneLines(state).pipe(
		Effect.filterOrFail(Array.isReadonlyArrayNonEmpty),
		Effect.retry(lineRetry),
		TestClock.withLive,
	);

	const opened = yield* mocks.open.received;

	assert.deepStrictEqual(
		{
			lines: pipe(
				lines,
				Array.map(({ account, lane, reason }) => [account, lane, reason]),
			),
			opened: opened.length,
		},
		{ lines: [["baa", "sealed", "failover"]], opened: 1 },
	);
});

/**
 * The open account and both BAA accounts refuse the connection, so no account answers and the request fails. Its one
 * line names the last BAA account it was sent to.
 */
const noneAnswered = Effect.gen(function* noneAnswered() {
	const { post, state } = yield* routed({
		baas: ["refused", "refused"],
		holdsPhi: () => false,
		opens: ["refused"],
	});

	const body = yield* bodyOf([{ role: "user", text: "Go on." }]);
	const response = yield* post({ body, session: "none-answered-1" });

	yield* response.text;

	const lines = yield* laneLines(state);

	assert.deepStrictEqual(
		{
			lines: pipe(
				lines,
				Array.map(({ account, lane, reason }) => [account, lane, reason]),
			),
			status: response.status,
		},
		{ lines: [["baa-2", "sealed", "failover"]], status: badGateway },
	);
});

/** A sealed request whose only BAA account's login ended fails, and its one line names that account. */
const sealedEnded = Effect.gen(function* sealedEnded() {
	const baaFolder = yield* endedLogin;
	const { mocks, post, state } = yield* routed({ baaFolder, holdsPhi: () => true });
	const body = yield* bodyOf([{ role: "user", text: "Member 4411 called." }]);
	const response = yield* post({ body, session: "sealed-ended-1" });

	yield* response.text;

	const opened = yield* mocks.open.received;
	const lines = yield* linesIn(state);

	assert.deepStrictEqual(
		{ lines, opened: opened.length, status: response.status },
		{ lines: [["baa", "sealed", "sealed new content"]], opened: 0, status: badGateway },
	);
});

/** A clean request whose home account's login ended moves to the next open account, and its line says failover. */
const homeEnded = Effect.gen(function* homeEnded() {
	const session = yield* Effect.fromOption(
		Array.findFirst(
			Array.makeBy(tries, (at) => `home-ended-${String(at)}`),
			(named) => homeOf({ count: twoAccounts, session: named }) === homeIndex,
		),
	);

	const openFolder = yield* endedLogin;
	const { post, state } = yield* routed({ holdsPhi: () => false, openFolder, opens: [answers, answers] });
	const body = yield* bodyOf([{ role: "user", text: "Go on." }]);
	const response = yield* post({ body, session });

	yield* response.text;

	const lines = yield* linesIn(state);

	assert.deepStrictEqual(lines, [["open-2", "clean", "failover"]]);
});

/** A sealed request moves past an open account whose login ended without trying it, so its line names no failover. */
const sealedPastEnded = Effect.gen(function* sealedPastEnded() {
	const openFolder = yield* endedLogin;
	const { mocks, post, state } = yield* routed({ holdsPhi: () => true, openFolder });
	const body = yield* bodyOf([{ role: "user", text: "Member 4411 called." }]);
	const response = yield* post({ body, session: "sealed-past-ended-1" });

	yield* response.text;

	const sealed = yield* mocks.baa.received;
	const lines = yield* linesIn(state);

	assert.deepStrictEqual(
		{ lines, sealed: sealed.length },
		{ lines: [["baa", "sealed", "sealed new content"]], sealed: 1 },
	);
});

/**
 * A store whose every read after the arrival's fails, so the walk ends before it reaches an account.
 *
 * @param {VerdictStore["Service"]} real The router's store.
 * @returns {VerdictStore["Service"]} The store that fails.
 */
const failingAfterArrival = (real: VerdictStore["Service"]): VerdictStore["Service"] => {
	const reads = { arrived: false };

	return Struct.assign(real, {
		read: (session: string, policy: string) =>
			Effect.suspend(() => {
				if (!reads.arrived) {
					reads.arrived = true;

					return real.read(session, policy);
				}

				return Effect.andThen(Schema.decodeUnknownEffect(Schema.Finite)("unreadable"), real.read(session, policy));
			}),
	});
};

/** A request whose store read fails on its walk still leaves its line, as a router failure at its home account. */
const storeFailed = Effect.gen(function* storeFailed() {
	const { mocks, post, state } = yield* routed({ holdsPhi: () => false, store: failingAfterArrival });
	const body = yield* bodyOf([{ role: "user", text: "Go on." }]);
	const response = yield* post({ body, session: "store-failed-1" });

	yield* response.text;

	const [opened = [], sealed = []] = yield* mocks.accounts;
	const lines = yield* linesIn(state);

	assert.deepStrictEqual(
		{ lines, sent: opened.length + sealed.length, status: response.status },
		{ lines: [["open", "clean", "router failure"]], sent: 0, status: failed },
	);
});

it.layer(NodeServices.layer)("a request's one lane log line", (test) => {
	test.effect(
		"is still written when the harness hangs up while a failed-over request waits on the BAA account, naming that account",
		() => hungUp,
	);
	test.effect("names the last account tried when no account answers, for failover", () => noneAnswered);
	test.effect("names a BAA account whose login ended when a sealed request has no other", () => sealedEnded);
	test.effect("says failover when the home account's login ended and the next open account answers", () => homeEnded);
	test.effect(
		"names no failover when a sealed request moves past an open account whose login ended",
		() => sealedPastEnded,
	);
	test.effect("is written as a router failure when the store cannot be read on the walk", () => storeFailed);
});
