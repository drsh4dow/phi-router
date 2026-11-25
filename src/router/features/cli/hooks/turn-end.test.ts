import { Array, DateTime, Effect, Option, Ref, Struct, flow, pipe } from "effect";
import { SessionId, productPort } from "#shared/cli.ts";
import { assert, it } from "@effect/vitest";
import type { Noticed } from "#router/client/turn-notices.ts";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { TestClock } from "effect/testing";
import { TurnNotices } from "#router/client/turn-notices.ts";
import { toldSince } from "./turn-end.ts";

const session = SessionId.make("s-turn-end");

const isoAt = (time: string): string => `2026-05-28T${time}:00.000Z`;

const millisAt = flow(isoAt, DateTime.makeUnsafe, DateTime.toEpochMillis);

interface Routed {
	readonly sealed: number;
	readonly overflowed: number;
	readonly back?: string;
}

const open = { name: "open", vendor: "anthropic" } as const;

const statusOf = (routed: Routed): Effect.Success<ReturnType<SessionRequests["Service"]["status"]>> => ({
	accounts: {
		clean: [
			Option.match(Option.fromUndefinedOr(routed.back), {
				onNone: () => open,
				onSome: (rateLimitedUntil) => Struct.assign(open, { rateLimitedUntil }),
			}),
			{ name: "codex-open", vendor: "openai" as const },
		],
		sealed: [{ name: "baa", vendor: "anthropic" as const }],
	},
	cleared: 0,
	last: { account: "baa", model: "claude-sealed", substitute: false },
	overflowed: routed.overflowed,
	sealed: routed.sealed,
	session,
});

const turnsOf = Effect.fnUntraced(function* turnsOf(turns: readonly (readonly [time: string, routed: Routed])[]) {
	const routed = yield* Ref.make<Routed>({ overflowed: 0, sealed: 0 });
	const file = yield* Ref.make(Option.none<Noticed>());

	const requests = SessionRequests.of({
		status: () => Effect.map(Ref.get(routed), statusOf),
	});

	const notices = TurnNotices.of({
		read: () => Ref.get(file),
		write: (_session, noticed) => Ref.set(file, Option.some(noticed)),
	});

	return yield* Effect.forEach(
		turns,
		([time, now]) =>
			Effect.gen(function* turn() {
				yield* TestClock.setTime(millisAt(time));
				yield* Ref.set(routed, now);

				const { told } = yield* toldSince(session, productPort).pipe(
					Effect.provideService(SessionRequests, requests),
					Effect.provideService(TurnNotices, notices),
				);

				return { overflow: pipe(told.overflow, Option.map(Struct.omit(["subscriptions"]))), sealed: told.sealed };
			}),
		{ concurrency: 1 },
	);
});

const sealedNow = { first: 1, next: 3 } as const;

it.effect(
	"a turn counts the messages sealed since the last turn end, and a session's first turn end counts from none",
	() =>
		Effect.gen(function* sealedCounts() {
			const told = yield* turnsOf([
				["14:00", { overflowed: 0, sealed: sealedNow.first }],
				["14:01", { overflowed: 0, sealed: sealedNow.next }],
			]);

			assert.deepStrictEqual(
				pipe(
					told,
					Array.map(({ sealed }) => sealed),
				),
				[sealedNow.first, sealedNow.next - sealedNow.first],
			);
		}),
);

it.effect(
	"overflow is told once per stamp with the earliest time the session's vendor gets a subscription back, and once per 30 minutes when no stamp explains it",
	() =>
		Effect.gen(function* overflowTold() {
			const told = yield* turnsOf([
				["14:00", { back: isoAt("14:30"), overflowed: 2, sealed: 0 }],
				["14:10", { back: isoAt("14:30"), overflowed: 5, sealed: 0 }],
				["14:31", { back: isoAt("15:01"), overflowed: 6, sealed: 0 }],
				["14:40", { back: isoAt("15:01"), overflowed: 6, sealed: 0 }],
				["15:30", { overflowed: 7, sealed: 0 }],
				["15:50", { overflowed: 8, sealed: 0 }],
				["16:01", { overflowed: 9, sealed: 0 }],
			]);

			assert.deepStrictEqual(
				pipe(
					told,
					Array.map(({ overflow }) => overflow),
				),
				[
					Option.some({ back: millisAt("14:30"), count: 2 }),
					Option.none(),
					Option.some({ back: millisAt("15:01"), count: 1 }),
					Option.none(),
					Option.some({ count: 1 }),
					Option.none(),
					Option.some({ count: 1 }),
				],
			);
		}),
);
