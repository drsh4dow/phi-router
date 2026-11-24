import { Array, Effect, Fiber, FileSystem, Path, Schedule, Schema, String as Str, Stream, Struct, pipe } from "effect";
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

const rateLimited = 429;

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

const limited: AccountScript = () => ({ body: "{}", kind: "status", status: rateLimited });

const untilLineWrittenOnRelease = { schedule: Schedule.spaced("20 millis") } as const;

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
		Effect.retry(untilLineWrittenOnRelease),
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

const sealedEnded = Effect.gen(function* sealedEnded() {
	const baaFolder = yield* endedLogin;
	const { mocks, post, state } = yield* routed({ baaFolder, holdsPhi: () => true });
	const body = yield* bodyOf([{ role: "user", text: "Member 4411 called." }]);
	const response = yield* post({ body, session: "sealed-ended-1" });
	const text = yield* response.text;
	const opened = yield* mocks.open.received;
	const lines = yield* linesIn(state);

	assert.deepStrictEqual(
		{
			fix: Str.includes(`CLAUDE_CONFIG_DIR=${baaFolder} claude auth login`)(text),
			lines,
			opened: opened.length,
			status: response.status,
		},
		{ fix: true, lines: [["baa", "sealed", "sealed new content"]], opened: 0, status: badGateway },
	);
});

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

const everyOpenStamped = Effect.gen(function* everyOpenStamped() {
	const { post, state } = yield* routed({ holdsPhi: () => false, open: limited });
	const body = yield* bodyOf([{ role: "user", text: "Go on." }]);

	yield* Effect.forEach(
		["stamped-1", "stamped-2"],
		(session) => Effect.flatMap(post({ body, session }), (response) => response.text),
		{ concurrency: 1 },
	);

	const lines = yield* linesIn(state);

	assert.deepStrictEqual(lines, [
		["baa", "sealed", "failover"],
		["baa", "sealed", "failover"],
	]);
});

const readsFailingAfterArrival = (real: VerdictStore["Service"]): VerdictStore["Service"] => {
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

const storeFailed = Effect.gen(function* storeFailed() {
	const { mocks, post, state } = yield* routed({ holdsPhi: () => false, store: readsFailingAfterArrival });
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
	test.effect(
		"names the BAA account whose login ended when a sealed request has no other and fails, and the 502 answer gives its login command",
		() => sealedEnded,
	);
	test.effect("says failover when the home account's login ended and the next open account answers", () => homeEnded);
	test.effect(
		"names no failover when a sealed request moves past an open account whose login ended without trying it",
		() => sealedPastEnded,
	);
	test.effect(
		"says failover at the BAA account for a clean request whose every open account is stamped",
		() => everyOpenStamped,
	);
	test.effect(
		"is written as a router failure at the home account when the store cannot be read on the walk",
		() => storeFailed,
	);
});
