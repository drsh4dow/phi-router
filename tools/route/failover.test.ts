import { Array, Effect, FileSystem, Latch, Option, Order, Schema, String as Str, Stream, pipe } from "effect";
import type { Post, Turn } from "./mocked-router.ts";
import { assert, it } from "@effect/vitest";
import { bodyOf, laneLines, routed } from "./mocked-router.ts";
import type { Cause } from "effect";
import { NodeServices } from "@effect/platform-node";
import type { Said } from "#router/client/mock-accounts.ts";
import type { Script } from "./harnesses.ts";
import { TestClock } from "effect/testing";
import { homeOf } from "#router/features/accounts/index.ts";
import { resetting } from "./resetting.ts";
import { textEvents } from "#router/client/mock-accounts.ts";

const canary = "PATIENT-CANARY-8F3D";

const holdsCanary = Str.includes(canary);

const status = { failed: 500, ok: 200, rateLimited: 429 } as const;

const tags = ["request-1", "request-2", "request-3"] as const;

const [one, two, three] = tags;

const clean = (tag: string): Turn => ({ role: "user", text: `List the build steps, ${tag}.` });

const phi: Turn = { role: "user", text: `Member ${canary} called, ${one}.` };

const tagsOf = (accounts: readonly (readonly { readonly body: string }[])[]): readonly (readonly string[])[] =>
	pipe(
		accounts,
		Array.map(
			Array.flatMap(({ body }) =>
				pipe(
					tags,
					Array.filter((tag) => Str.includes(tag)(body)),
				),
			),
		),
	);

const answering =
	(code: number): Script =>
	(): Said => ({ body: "{}", kind: "status", status: code });

const limited = answering(status.rateLimited);

const failing = answering(status.failed);

const stalling: Script = () => ({ kind: "stalled", status: status.failed });

const ok: Script = () => ({ events: Stream.fromIterable(textEvents(["ok"])), kind: "events" });

const twoAccounts = 2;

const firstAccount = 0;

const tries = 100;

const homedFirst = (prefix: string): Effect.Effect<string, Cause.NoSuchElementError> =>
	pipe(
		Array.makeBy(tries, (index) => `${prefix}-${String(index)}`),
		Array.findFirst((session) => homeOf({ count: twoAccounts, session }) === firstAccount),
		Effect.fromOption,
	);

const posted = Effect.fnUntraced(function* posted(post: Post, session: string, turns: readonly Turn[]) {
	const body = yield* bodyOf(turns);
	const response = yield* post({ body, session });
	const text = yield* response.text;

	return { status: response.status, text };
});

const stamped = Effect.gen(function* stamped() {
	const session = yield* homedFirst("failover-1");
	const { mocks, post } = yield* routed({ holdsPhi: holdsCanary, opens: [limited, ok] });
	const first = yield* posted(post, session, [clean(one)]);
	const skipped = yield* posted(post, session, [clean(two)]);
	const atSkip = yield* mocks.accounts;

	yield* TestClock.adjust("31 minutes");

	const after = yield* posted(post, session, [clean(three)]);
	const atEnd = yield* mocks.accounts;

	assert.deepStrictEqual(
		{ atEnd: tagsOf(atEnd), atSkip: tagsOf(atSkip), statuses: [first.status, skipped.status, after.status] },
		{
			atEnd: [[one, three], [one, two, three], []],
			atSkip: [[one], [one, two], []],
			statuses: [status.ok, status.ok, status.ok],
		},
	);
});

const fellOver = Effect.gen(function* fellOver() {
	const resets = yield* resetting;

	const { mocks, post, state } = yield* routed({
		holdsPhi: holdsCanary,
		opens: [limited, stalling, "refused", resets],
	});

	const answer = yield* posted(post, "failover-2", [clean(one)]);
	const lines = yield* laneLines(state);
	const received = yield* mocks.accounts;

	assert.deepStrictEqual<unknown>(
		{
			lines: pipe(
				lines,
				Array.map(({ account, lane, reason }) => [account, lane, reason]),
			),
			received: tagsOf(received),
			status: answer.status,
		},
		{
			lines: [["baa", "sealed", "failover"]],
			received: [[one], [one], [], [], [one]],
			status: status.ok,
		},
	);
});

const afterFirstByte = Effect.gen(function* afterFirstByte() {
	const firstRead = yield* Latch.make();
	const opening = pipe(textEvents(["partial"]), Array.head, Option.toArray);

	const breaking: Script = () => ({
		events: Stream.concat(
			Stream.fromIterable(opening),
			Stream.flatMap(Stream.fromEffect(firstRead.await), () => Stream.die("the account hung up")),
		),
		kind: "events",
	});

	const { mocks, post } = yield* routed({ holdsPhi: holdsCanary, open: breaking });
	const body = yield* bodyOf([clean(one)]);
	const response = yield* post({ body, session: "failover-3" });

	const partial = yield* response.stream.pipe(
		Stream.decodeText,
		Stream.tap(() => firstRead.open),
		Stream.catchCause(() => Stream.empty),
		Stream.mkString,
	);

	const received = yield* mocks.accounts;

	assert.deepStrictEqual(
		{ partial: Str.includes("message_start")(partial), received: tagsOf(received) },
		{ partial: true, received: [[one], []] },
	);
});

const sealedWalk = Effect.gen(function* sealedWalk() {
	const fs = yield* FileSystem.FileSystem;
	const walking = yield* routed({ baas: [limited, ok], holdsPhi: holdsCanary });
	const walked = yield* posted(walking.post, "failover-4", [phi]);
	const walkedTo = yield* walking.mocks.accounts;
	const stampsWritten = yield* fs.exists(`${walking.state}/accounts.json`);
	const allFailing = yield* routed({ baas: [failing, failing], holdsPhi: holdsCanary });
	const failed = yield* posted(allFailing.post, "failover-5", [phi]);
	const lines = yield* laneLines(allFailing.state);
	const failedAt = yield* allFailing.mocks.accounts;

	assert.deepStrictEqual<unknown>(
		{
			failed: [failed.status, tagsOf(failedAt)],
			lines: pipe(
				lines,
				Array.map(({ account, reason }) => [account, reason]),
			),
			walked: [walked.status, tagsOf(walkedTo), stampsWritten],
		},
		{
			failed: [status.failed, [[], [one], [one]]],
			lines: [["baa-2", "failover"]],
			walked: [status.ok, [[], [one], [one]], false],
		},
	);
});

const sessionCount = 12;

const sessions = Array.makeBy(sessionCount, (index) => `home-${String(index)}`);

const homes = Effect.gen(function* homes() {
	const { mocks, post } = yield* routed({ holdsPhi: holdsCanary, opens: [ok, ok] });

	yield* Effect.forEach(
		[...sessions, ...sessions],
		(session) => posted(post, session, [{ role: "user", text: `From ${session}.` }]),
		{ concurrency: 1 },
	);

	const received = yield* mocks.accounts;

	const servedBy = pipe(
		received,
		Array.map((sent) =>
			pipe(
				sessions,
				Array.filter((session) =>
					pipe(
						sent,
						Array.some(({ body }) => Str.includes(`From ${session}.`)(body)),
					),
				),
			),
		),
	);

	assert.deepStrictEqual(
		{
			eachOnce: Array.sort(Array.flatten(servedBy), Order.String),
			eachServes: pipe(servedBy, Array.take(twoAccounts), Array.every(Array.isReadonlyArrayNonEmpty)),
		},
		{ eachOnce: Array.sort(sessions, Order.String), eachServes: true },
	);
});

const replyText = "A-REPLY-6M2P";

const followUp: Turn = { role: "user", text: "Go on." };

const writesThenLimits: Script = (asked) => {
	if (Str.includes(replyText)(asked.body)) {
		return limited(asked);
	}

	return { events: Stream.fromIterable(textEvents([replyText])), kind: "events" };
};

const replyKeys = Effect.gen(function* replyKeys() {
	const session = yield* homedFirst("failover-6");
	const { mocks, post } = yield* routed({ holdsPhi: holdsCanary, opens: [writesThenLimits, ok] });
	const wrote = yield* posted(post, session, [clean(one)]);
	const echoed = yield* posted(post, session, [clean(one), { role: "assistant", text: replyText }, followUp]);
	const judged = yield* mocks.judge.received;
	const judgedText = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(judged);
	const [, other] = yield* mocks.accounts;

	assert.deepStrictEqual<unknown>(
		{
			judgedReply: Str.includes(replyText)(judgedText),
			otherGotReply: pipe(
				other ?? [],
				Array.map(({ body }) => Str.includes(replyText)(body)),
			),
			statuses: [wrote.status, echoed.status],
		},
		{ judgedReply: false, otherGotReply: [true], statuses: [status.ok, status.ok] },
	);
});

it.layer(NodeServices.layer)("several accounts per lane", (test) => {
	test.effect(
		"a home account's 429 sends the request to the next open account, and the session skips it for 30 minutes",
		() => stamped,
	);
	test.effect(
		"every open account answering 429, a 500 whose body never ends, refusing or resetting sends the request to the BAA account, whose one lane log line says failover",
		() => fellOver,
	);
	test.effect(
		"a reply that breaks after its first byte reaches the harness as it came, and no other account gets the request",
		() => afterFirstByte,
	);
	test.effect(
		"a canary request walks the BAA accounts in order and never an open one: the second answers when the first gives 429, which stamps no BAA account, and when all give 500 the last 500 passes and the one lane log line names the last account, for failover",
		() => sealedWalk,
	);
	test.effect("each session keeps its home account, and the sessions spread over both open accounts", () => homes);
	test.effect(
		"a reply one open account wrote reaches the next open account as written, and the judge never reads it",
		() => replyKeys,
	);
});
