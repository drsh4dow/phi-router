import { Effect, Layer, Option } from "effect";
import { SessionId, productPort } from "#shared/cli.ts";
import { assert, it } from "@effect/vitest";
import { SealNotices } from "#router/client/seal-notices.ts";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { sealedSince } from "./turn-end.ts";

const session = SessionId.make("s-turn-end");

const sealedNow = 3;

const sealedAtLastTurnEnd = 1;

const routerAnswering = Layer.mock(SessionRequests, {
	status: () =>
		Effect.succeed({
			accounts: { clean: [], sealed: [] },
			cleared: 0,
			last: { account: "baa", model: "claude-sealed", substitute: false },
			pinned: false,
			sealed: sealedNow,
			session,
		}),
});

it.effect(
	"a turn counts the messages sealed since the last turn end, and a session's first turn end counts from none",
	() =>
		Effect.gen(function* sealedCounts() {
			const counts = yield* Effect.forEach(
				[Option.none(), Option.some(sealedAtLastTurnEnd)],
				(before) =>
					sealedSince(session, productPort).pipe(
						Effect.provide([routerAnswering, Layer.mock(SealNotices, { swap: () => Effect.succeed(before) })]),
						Effect.map(({ count }) => count),
					),
				{ concurrency: 1 },
			);

			assert.deepStrictEqual(counts, [sealedNow, sealedNow - sealedAtLastTurnEnd]);
		}),
);
