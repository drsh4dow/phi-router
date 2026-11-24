import { Array, Effect, Fiber, Queue, String as Str, Stream, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { bodyOf, routed } from "./mocked-router.ts";
import { codexBodyOf, replyMessage, userMessage } from "./harnesses.ts";
import { responseEvents, textEvents } from "#router/client/mock-upstreams/index.ts";
import type { Cause } from "effect";
import type { Event } from "#router/client/mock-upstreams/index.ts";
import { NodeServices } from "@effect/platform-node";

const deltas = { first: 1, last: 10 } as const;

const counted = pipe(
	Array.range(deltas.first, deltas.last),
	Array.map((count) => ` ${String(count)}`),
);

const asked = "Count to ten.";

const harnesses = {
	claude: { body: bodyOf([{ role: "user", text: asked }]), events: textEvents(counted) },
	codex: {
		body: codexBodyOf([userMessage(asked)]),
		events: responseEvents(
			pipe(
				counted,
				Array.map((text) => replyMessage({ id: `msg${text}`, text })),
			),
		),
	},
} as const;

const eventLine = "event: ";

const streaming = Effect.fnUntraced(function* streaming(harness: keyof typeof harnesses) {
	const { events } = harnesses[harness];
	const toSend = yield* Queue.unbounded<Event, Cause.Done>();
	const arrived = yield* Queue.unbounded<string>();

	const { post } = yield* routed({
		harness,
		holdsPhi: () => false,
		open: () => ({ events: Stream.fromQueue(toSend), kind: "events" }),
	});

	const body = yield* harnesses[harness].body;

	const reading = yield* Effect.forkChild(
		Effect.flatMap(post({ body, session: "streaming-1" }), (response) =>
			response.stream.pipe(
				Stream.decodeText,
				Stream.splitLines,
				Stream.filter(Str.startsWith(eventLine)),
				Stream.runForEach((line) => Queue.offer(arrived, Str.slice(eventLine.length)(line))),
			),
		),
	);

	const seen = yield* Effect.forEach(
		events,
		(event) => Queue.offer(toSend, event).pipe(Effect.andThen(Queue.take(arrived))),
		{ concurrency: 1 },
	);

	yield* Queue.end(toSend);
	yield* Fiber.join(reading);

	assert.deepStrictEqual(
		seen,
		pipe(
			events,
			Array.map((event) => event.type),
		),
	);
});

it.layer(NodeServices.layer)("a reply", (test) => {
	test.effect.each(["claude", "codex"] as const)(
		"to %s reaches the harness event by event, before the account sends the next",
		streaming,
	);
});
