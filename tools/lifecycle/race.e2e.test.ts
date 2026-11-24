import { Array, Effect, Order, Schedule, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { bundled, instance, leasedPids, world } from "./launched.ts";
import { NodeServices } from "@effect/platform-node";
import { TestClock } from "effect/testing";

const rounds = 20;
const patient = { timeout: 120_000 };
const together = 2;
const clean = 0;
const bothLaunches = 2;

/** A launch that lost the race retries the bind for 2 s, then exits. */
const settleLimit = "5 seconds";

const sortedPids = (pids: readonly number[]): string =>
	pipe(pids, Array.sortBy(Order.Number), Array.map(String), Array.join(","));

const raced = Effect.fnUntraced(function* raced(entry: string) {
	const here = yield* world(entry);
	const first = yield* instance();
	const second = yield* instance();

	const [one, two] = yield* Effect.all([here.start(first.pid), here.start(second.pid)], { concurrency: "unbounded" });
	const leases = yield* leasedPids(here.state);

	const routers = yield* here.routers.pipe(
		Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (pids) => pids.length < bothLaunches }),
		Effect.timeout(settleLimit),
		TestClock.withLive,
	);

	return {
		exits: [one.exitCode, two.exitCode],
		leasesHeld: sortedPids(leases) === sortedPids([first.pid, second.pid]),
		routers: routers.length,
	};
}, Effect.scoped);

it.layer(NodeServices.layer)("two starts racing with no router up", (test) => {
	test.effect(
		`leave one router holding both leases, ${String(rounds)} times over`,
		() =>
			Effect.gen(function* racing() {
				const entry = yield* bundled();

				const seen = yield* Effect.forEach(
					Array.makeBy(rounds, () => entry),
					raced,
					{ concurrency: together },
				);

				assert.deepStrictEqual(
					seen,
					Array.makeBy(rounds, () => ({ exits: [clean, clean], leasesHeld: true, routers: 1 })),
				);
			}).pipe(Effect.scoped),
		patient,
	);
});
