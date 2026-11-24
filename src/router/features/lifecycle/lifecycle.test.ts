import { Array, Effect, Fiber, Latch, Layer, Number as Num, Option, PlatformError, Ref, pipe } from "effect";
import type { Outgoing, Path } from "#router/client/router-port/index.ts";
import { assert, it } from "@effect/vitest";
import type { Lease } from "#router/client/leases.ts";
import { LeaseRegistry } from "#router/client/leases.ts";
import { Processes } from "#router/client/processes.ts";
import type { Running } from "#router/client/processes.ts";
import { TestClock } from "effect/testing";
import { lifecycle } from "./lifecycle.ts";

type Leases = readonly (typeof Lease.Type)[];

const ok = 200;
const badRequest = 400;
const ended = 409;
const unavailable = 503;
const harness = 101;
const other = 202;
const none = 0;
const once = 1;
const monday = "Mon Jan  5 10:00:00 2026";
const tuesday = "Tue Jan  6 10:00:00 2026";
const justBefore = "4999 millis";
const oneInterval = "5 seconds";

const leaseLine = (pid: number): string => `{"folder":"/work","pid":${String(pid)},"session":"s1"}`;
const leaseOf = (pid: number, started: string): typeof Lease.Type => ({ folder: "/work", pid, session: "s1", started });
const runningAs = (pid: number, started: string): Running => ({ pid, started });

/** A fault the machine injects: none, a `ps` that reads nothing, or a full disk. */
type Fault = "none" | "unread" | "full";

const diskFull = PlatformError.badArgument({
	description: "no space left on device",
	method: "writeAll",
	module: "FileSystem",
});

/**
 * The processes of a test machine, `running` at first. `calls` counts the `ps` calls, and a `ps` that asks about
 * `harness` waits while `gate` is closed. While `fault` is `unread` every `ps` reads nothing, and while it is `full` every
 * write of the registry fails.
 */
const processesOf = Effect.fnUntraced(function* processesOf(running: readonly Running[]) {
	const processes = yield* Ref.make(running);
	const calls = yield* Ref.make(none);
	const gate = yield* Latch.make(true);
	const fault = yield* Ref.make<Fault>("none");

	const ps = Effect.fnUntraced(function* ps(pids: readonly number[]) {
		yield* Ref.update(calls, Num.increment);
		yield* Effect.when(gate.await, Effect.succeed(Array.contains(pids, harness)));

		const injected = yield* Ref.get(fault);

		if (injected === "unread") {
			return Option.none();
		}

		const now = yield* Ref.get(processes);

		return Option.some(
			pipe(
				now,
				Array.filter(({ pid }) => Array.contains(pids, pid)),
			),
		);
	});

	const ends = (pid: number): Effect.Effect<void> =>
		Ref.update(
			processes,
			Array.filter((alive) => alive.pid !== pid),
		);

	return { calls, ends, fault, gate, ps };
});

/** A machine whose processes are `running` and whose lease registry holds `stored`. `writes` counts the stores. */
const machine = Effect.fnUntraced(function* machine(running: readonly Running[], stored: Leases) {
	const { calls, ends, fault, gate, ps } = yield* processesOf(running);
	const registry = yield* Ref.make(stored);
	const writes = yield* Ref.make(none);

	const store = Effect.fnUntraced(function* store(leases: Leases) {
		const injected = yield* Ref.get(fault);

		if (injected === "full") {
			return yield* diskFull;
		}

		yield* Ref.set(registry, leases);

		return yield* Ref.update(writes, Num.increment);
	});

	const services = yield* Layer.mergeAll(
		Layer.mock(Processes, { running: ps }),
		Layer.mock(LeaseRegistry, { adopted: Ref.get(registry), store }),
	).pipe(Layer.build);

	const life = yield* Effect.provideContext(lifecycle, services);

	return { calls, ends, fault, gate, life, registry, writes };
});

const asked = (answer: Path["answer"], body: string): Effect.Effect<Outgoing> =>
	answer({ body, headers: {}, query: {} }).pipe(Effect.scoped);

it.effect("a lease is on disk with its start time when the router answers, and a second one changes nothing", () =>
	Effect.gen(function* registered() {
		const world = yield* machine([runningAs(harness, monday)], []);

		const first = yield* asked(world.life.path.answer, leaseLine(harness));
		const stored = yield* Ref.get(world.registry);
		const second = yield* asked(world.life.path.answer, leaseLine(harness));
		const writes = yield* Ref.get(world.writes);

		assert.strictEqual(first.status, ok);
		assert.deepStrictEqual(stored, [leaseOf(harness, monday)]);
		assert.strictEqual(second.status, ok);
		assert.strictEqual(writes, once);
	}),
);

it.effect("a lease asked for while ps cannot read the processes gets 503 and is taken once ps reads again", () =>
	Effect.gen(function* unread() {
		const world = yield* machine([runningAs(harness, monday)], []);

		yield* Ref.set(world.fault, "unread");

		const meanwhile = yield* asked(world.life.path.answer, leaseLine(harness));

		yield* Ref.set(world.fault, "none");

		const again = yield* asked(world.life.path.answer, leaseLine(harness));
		const stored = yield* Ref.get(world.registry);

		assert.deepStrictEqual(
			{ again: again.status, meanwhile: meanwhile.status, stored },
			{ again: ok, meanwhile: unavailable, stored: [leaseOf(harness, monday)] },
		);
	}),
);

it.effect("a pid with no process gets 409 and no lease, and an unreadable request 400", () =>
	Effect.gen(function* refused() {
		const world = yield* machine([], []);

		const gone = yield* asked(world.life.path.answer, leaseLine(harness));
		const garbled = yield* asked(world.life.path.answer, '{"pid":"101"}');
		const writes = yield* Ref.get(world.writes);

		assert.strictEqual(gone.status, ended);
		assert.strictEqual(garbled.status, badRequest);
		assert.strictEqual(writes, none);
	}),
);

it.effect("the first lease check runs one interval after start, and stops the router when no adopted lease holds", () =>
	Effect.gen(function* firstCheck() {
		const world = yield* machine([], [leaseOf(harness, monday)]);
		const watching = yield* Effect.forkChild(world.life.watching);

		yield* TestClock.adjust(justBefore);

		const calls = yield* Ref.get(world.calls);

		assert.strictEqual(calls, none);

		yield* TestClock.adjust("1 millis");
		yield* Fiber.join(watching);

		const late = yield* asked(world.life.path.answer, leaseLine(other));
		const registry = yield* Ref.get(world.registry);

		assert.deepStrictEqual({ registry, status: late.status }, { registry: [], status: unavailable });
	}),
);

it.effect("an adopted lease whose process runs keeps the router up across checks until that process ends", () =>
	Effect.gen(function* adopted() {
		const world = yield* machine([runningAs(harness, monday)], [leaseOf(harness, monday)]);
		const watching = yield* Effect.forkChild(world.life.watching);

		yield* TestClock.adjust("15 seconds");

		const held = yield* asked(world.life.path.answer, leaseLine(harness));
		const writes = yield* Ref.get(world.writes);

		assert.deepStrictEqual({ status: held.status, writes }, { status: ok, writes: none });

		yield* world.ends(harness);
		yield* TestClock.adjust(oneInterval);

		const registry = yield* Fiber.join(watching).pipe(Effect.andThen(Ref.get(world.registry)));

		assert.deepStrictEqual(registry, []);
	}),
);

it.effect("a lease whose pid now belongs to a process with another start time no longer holds", () =>
	Effect.gen(function* reused() {
		const world = yield* machine(
			[runningAs(harness, tuesday), runningAs(other, monday)],
			[leaseOf(harness, monday), leaseOf(other, monday)],
		);

		const watching = yield* Effect.forkChild(world.life.watching);

		yield* TestClock.adjust(oneInterval);

		const registry = yield* Ref.get(world.registry);

		assert.deepStrictEqual(registry, [leaseOf(other, monday)]);

		yield* world.ends(other);
		yield* TestClock.adjust(oneInterval);
		yield* Fiber.join(watching);
	}),
);

it.effect("a lease taken while a check runs outlives the lease the router held before it", () =>
	Effect.gen(function* racing() {
		const world = yield* machine([runningAs(harness, monday), runningAs(other, monday)], [leaseOf(harness, monday)]);

		yield* Effect.forkChild(world.life.watching);

		const calls = yield* world.gate.close.pipe(
			Effect.andThen(TestClock.adjust(oneInterval)),
			Effect.andThen(Ref.get(world.calls)),
		);

		const taking = yield* Effect.forkChild(asked(world.life.path.answer, leaseLine(other)));

		yield* world.gate.open;

		const taken = yield* Fiber.join(taking);

		yield* world.ends(harness).pipe(Effect.andThen(TestClock.adjust(oneInterval)));

		const registry = yield* Ref.get(world.registry);
		const after = yield* asked(world.life.path.answer, leaseLine(other));

		assert.deepStrictEqual(
			{ after: after.status, calls, registry, taken: taken.status },
			{ after: ok, calls: once, registry: [leaseOf(other, monday)], taken: ok },
		);
	}),
);

it.effect(
	"a check that cannot read the processes or whose write fails keeps the router up, and a later check drops the lease",
	() =>
		Effect.gen(function* broken() {
			const world = yield* machine(
				[runningAs(harness, monday), runningAs(other, monday)],
				[leaseOf(harness, monday)],
			);

			const watching = yield* Effect.forkChild(world.life.watching);

			yield* asked(world.life.path.answer, leaseLine(other));
			yield* world.ends(other).pipe(Effect.andThen(Ref.set(world.fault, "unread")));
			yield* TestClock.adjust(oneInterval);
			yield* Ref.set(world.fault, "full").pipe(
				Effect.andThen(TestClock.adjust(oneInterval)),
				Effect.andThen(Ref.set(world.fault, "none")),
			);

			const stillUp = yield* asked(world.life.path.answer, leaseLine(harness));

			yield* world
				.ends(harness)
				.pipe(Effect.andThen(TestClock.adjust(oneInterval)), Effect.andThen(Fiber.join(watching)));

			const last = yield* Ref.get(world.registry);

			assert.deepStrictEqual({ last, stillUp: stillUp.status }, { last: [], stillUp: ok });
		}),
);
