import { Context, Effect, Layer, PlatformError } from "effect";
import { assert, it, vi } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/process";
import { FetchHttpClient } from "effect/http";
import { LeaseRequests } from "./lease-request.ts";

const port = 47_411;

const lease = { folder: "/work", pid: 101, session: "s1" };

const statuses = { closing: 503, failing: 500, stored: 200, taken: 201, whenEnded: 409 } as const;

const noShell = ChildProcessSpawner.make(() =>
	Effect.fail(PlatformError.badArgument({ description: "no shell here", method: "spawn", module: "ChildProcess" })),
);

const postedTo = Effect.fnUntraced(function* postedTo(answer: typeof FetchHttpClient.Fetch.Service) {
	const spawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, noShell);
	const built = yield* Layer.build(Layer.provide(LeaseRequests.layer, spawner));

	return yield* Context.get(built, LeaseRequests)
		.post(port, lease)
		.pipe(Effect.provideService(FetchHttpClient.Fetch, answer));
});

const answering = (status: number): typeof FetchHttpClient.Fetch.Service =>
	vi.fn<typeof FetchHttpClient.Fetch.Service>().mockResolvedValue(new Response("", { status }));

const refused = vi.fn<typeof FetchHttpClient.Fetch.Service>().mockRejectedValue(new TypeError("fetch failed"));

const answers = Effect.gen(function* answers() {
	const answered = yield* Effect.all(
		{
			closing: postedTo(answering(statuses.closing)),
			failing: postedTo(answering(statuses.failing)),
			nothingListens: postedTo(refused),
			stored: postedTo(answering(statuses.stored)),
			taken: postedTo(answering(statuses.taken)),
			whenEnded: postedTo(answering(statuses.whenEnded)),
		},
		{ concurrency: 1 },
	);

	assert.deepStrictEqual(answered, {
		closing: "waiting",
		failing: "waiting",
		nothingListens: "unanswered",
		stored: "accepted",
		taken: "waiting",
		whenEnded: "ended",
	});
});

it.effect(
	"a lease post learns accepted from 200, ended from 409, unanswered when nothing listens, and waiting from any other answer",
	() => Effect.scoped(answers),
);
