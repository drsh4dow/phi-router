import { Array, Effect, Latch, Predicate, Schedule, String as Str, Stream, identity, pipe } from "effect";
import type { Asked, Said } from "#router/client/mock-upstreams/index.ts";
import { assert, it, vi } from "@effect/vitest";
import { bodyOf, laneLines, routed } from "./mocked-router.ts";
import { FetchHttpClient } from "effect/http";
import type { HttpClientError } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import type { Post } from "./mocked-router.ts";
import { TestClock } from "effect/testing";
import { textEvents } from "#router/client/mock-upstreams/index.ts";

const ok = 200;

const patient = { timeout: 60_000 };

const asked = { clean: "List the build steps.", slowly: "Count to ten, slowly." } as const;

const batches = { first: 20, second: 200 } as const;

const first = 1;

const none = 0;

const okReply: Said = { events: Stream.fromIterable(textEvents(["ok"])), kind: "events" };

const opening = Array.take(textEvents(["one"]), first);

/** The fetch the router calls its accounts with, and for each call it made to `endpoint`, whether its abort is held. */
interface Spied {
	readonly fetch: typeof globalThis.fetch;
	readonly held: (endpoint: string) => readonly boolean[];
}

/**
 * The router aborts each call when its request's scope closes, so a call it has not aborted after the answer is an
 * abort, a controller and a finalizer the router still holds.
 *
 * @returns {Spied} The spied fetch, and what it saw.
 */
const spied = (): Spied => {
	const fetch = vi.fn<typeof globalThis.fetch>(FetchHttpClient.Fetch.defaultValue());

	const held = (endpoint: string): readonly boolean[] =>
		pipe(
			fetch.mock.calls,
			Array.filter(([input]) => Str.startsWith(endpoint)(new Request(input).url)),
			Array.map(([, init = {}]) => Predicate.isNullish(init.signal) || !init.signal.aborted),
		);

	return { fetch, held };
};

const countHeld = (calls: readonly boolean[]): number => pipe(calls, Array.filter(identity)).length;

const answered = (post: Post, body: string, count: number): Effect.Effect<void, HttpClientError.HttpClientError> => {
	const once = Effect.flatMap(post({ body, session: "scope-1" }), (answer) => answer.text);

	return Effect.all(Array.replicate(once, count), { concurrency: 1, discard: true });
};

/** After 200 more requests, the router holds no more aborts than 20 left. */
const flat = Effect.gen(function* flat() {
	const { fetch, held } = spied();
	const { mocks, post } = yield* routed({ fetch, holdsPhi: () => false });
	const body = yield* bodyOf([{ role: "user", text: asked.clean }]);

	yield* answered(post, body, batches.first);
	const afterFirst = countHeld(held(mocks.open.endpoint));
	yield* answered(post, body, batches.second);
	const calls = held(mocks.open.endpoint);
	const grown = countHeld(calls) - afterFirst;

	assert.deepStrictEqual(
		{ calls: calls.length, grew: grown >= batches.first },
		{ calls: batches.first + batches.second, grew: false },
		`${String(batches.second)} more requests left ${String(grown)} more aborts held`,
	);
});

/** An open account that answers `ok`, but to the slow question sends one event and nothing more until it is hung up on. */
const slowAccount = Effect.map(Latch.make(), (closed) => ({
	closed: closed.await,
	script: ({ last }: Asked): Said => {
		if (!Str.includes(asked.slowly)(last)) {
			return okReply;
		}

		const events = Stream.concat(Stream.fromIterable(opening), Stream.never);

		return { events: Stream.ensuring(events, closed.open), kind: "events" };
	},
}));

const hungUp = Effect.fnUntraced(function* hungUp(post: Post) {
	const body = yield* bodyOf([{ role: "user", text: asked.slowly }]);
	const answer = yield* post({ body, session: "hang-up-1" });

	yield* Stream.runDrain(Stream.take(answer.stream, first));
});

const released = (held: () => readonly boolean[]): Effect.Effect<readonly boolean[]> =>
	Effect.repeat(Effect.sync(held), {
		schedule: Schedule.spaced("10 millis"),
		until: (calls) => Array.isReadonlyArrayNonEmpty(calls) && countHeld(calls) === none,
	});

/**
 * The harness hangs up after the first event of a reply the open account never finishes. The router aborts the
 * account's request and the open account sees its connection close. The next request still answers 200, and the lane
 * log keeps a line for each request the account received.
 */
const hangUp = Effect.gen(function* hangUp() {
	const { fetch, held } = spied();
	const account = yield* slowAccount;
	const { mocks, post, state } = yield* routed({ fetch, holdsPhi: () => false, open: account.script });
	const clean = yield* bodyOf([{ role: "user", text: asked.clean }]);

	yield* hungUp(post);

	yield* Effect.all([account.closed, released(() => held(mocks.open.endpoint))], { concurrency: "unbounded" }).pipe(
		TestClock.withLive,
	);

	const next = yield* Effect.tap(post({ body: clean, session: "hang-up-1" }), (answer) => answer.text);
	const [lines, received] = yield* Effect.all([laneLines(state), mocks.open.received], { concurrency: 1 });

	assert.deepStrictEqual({ lines: lines.length, next: next.status }, { lines: received.length, next: ok });
});

it.layer(NodeServices.layer)("each request the router sends an account", (test) => {
	test.effect(
		"leaves no abort held once answered, so 200 more requests hold no more than 20 did",
		() => flat,
		patient,
	);
	test.effect("is aborted when the harness hangs up mid-stream, and the next request still answers", () => hangUp);
});
