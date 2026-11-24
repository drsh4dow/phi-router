import { Array, Effect, Option, Schema, Struct, SynchronizedRef, pipe } from "effect";
import { Lease, LeaseRegistry } from "#router/client/leases.ts";
import type { LeaseReply, LeaseRequest, Outgoing, Path } from "#router/client/router-port/index.ts";
import { LeaseRequestJson, leasePath, statusOf } from "#router/client/router-port/index.ts";
import type { LiveProcess } from "#router/client/processes.ts";
import { Processes } from "#router/client/processes.ts";
import type { RegistryFailed } from "#router/client/leases.ts";

/** How often the router checks its leases. A router with none left is gone before the next check would run. */
const leaseInterval = "5 seconds";

type Leases = readonly (typeof Lease.Type)[];

/** A closing router holds no leases, so nothing can be added to them. */
type Leasing = { readonly kind: "accepting"; readonly leases: Leases } | { readonly kind: "closing" };

type Registered = readonly [LeaseReply, Leasing];

const sameLease = Schema.toEquivalence(Lease);

const badRequest = 400;

const answered = (status: number, reply: string): Outgoing => ({ body: `{"lease":"${reply}"}`, kind: "whole", status });

/**
 * The leases whose pid runs with the lease's start time.
 *
 * @param {Leases} leases The leases.
 * @param {readonly LiveProcess[]} running The processes that run now.
 * @returns {Leases} The leases that hold.
 */
const held = (leases: Leases, running: readonly LiveProcess[]): Leases =>
	pipe(
		leases,
		Array.filter((lease) =>
			pipe(
				running,
				Array.some(({ pid, started }) => pid === lease.pid && started === lease.started),
			),
		),
	);

const runningOf = (pids: readonly number[]): Effect.Effect<Option.Option<readonly LiveProcess[]>, never, Processes> =>
	Processes.use((processes) => processes.running(pids));

const pidsOf = (leases: Leases): readonly number[] =>
	pipe(
		leases,
		Array.map((lease) => lease.pid),
	);

const stored = (leases: Leases): Effect.Effect<void, RegistryFailed, LeaseRegistry> =>
	LeaseRegistry.use((registry) => registry.store(leases));

/**
 * The leases with `lease` among them. The same array when it already holds an equal lease, so taking a lease twice
 * changes nothing.
 *
 * @param {Leases} leases The leases.
 * @param {typeof Lease.Type} lease The lease to take.
 * @returns {Leases} The leases with it.
 */
const withLease = (leases: Leases, lease: typeof Lease.Type): Leases => {
	const taken = pipe(
		leases,
		Array.some((other) => sameLease(other, lease)),
	);

	if (taken) {
		return leases;
	}

	return [...leases, lease];
};

/**
 * One lease check: drops every lease that no longer holds, and stops accepting when none is left. A check that could
 * not read the processes keeps every lease until the next one. A failed write keeps the router up, and leaves the
 * dropped leases on disk for a later check to drop again.
 */
const checked = Effect.fnUntraced(function* checked(now: Leasing) {
	if (now.kind === "closing") {
		return now;
	}

	const running = yield* runningOf(pidsOf(now.leases));

	if (Option.isNone(running)) {
		return yield* Effect.as(
			Effect.logWarning("the lease check could not read the processes and keeps every lease"),
			now,
		);
	}

	const kept = held(now.leases, running.value);

	yield* Effect.when(Effect.ignore(stored(kept), { log: true }), Effect.succeed(kept.length < now.leases.length));

	if (Array.isReadonlyArrayEmpty(kept)) {
		return { kind: "closing" } satisfies Leasing;
	}

	return { kind: "accepting", leases: kept } satisfies Leasing;
});

/**
 * Takes a lease for a running pid, on disk before it answers. A closing router takes none. A read of the processes that
 * did not prove it worked takes none, and `start` asks again.
 */
const registered = Effect.fnUntraced(function* registered(now: Leasing, request: typeof LeaseRequest.Type) {
	if (now.kind === "closing") {
		return ["closing", now] satisfies Registered;
	}

	const read = yield* runningOf([request.pid]);

	if (Option.isNone(read)) {
		return ["unread", now] satisfies Registered;
	}

	if (!Array.isReadonlyArrayNonEmpty(read.value)) {
		return ["ended", now] satisfies Registered;
	}

	const leases = withLease(now.leases, Struct.assign(request, { started: Array.headNonEmpty(read.value).started }));

	yield* Effect.when(stored(leases), Effect.succeed(leases !== now.leases));

	return ["accepted", { kind: "accepting", leases }] satisfies Registered;
});

/**
 * The router's lifecycle, built by `serve` once the port is bound. It adopts the stored lease registry. `path` is the
 * lease row of the path table. `watching` checks the leases once per interval and returns when a check finds none,
 * having stopped accepting in that same step. Taking a lease and the check each hold one permit across their `ps`
 * call and their write, so neither runs inside the other.
 */
const lifecycle = Effect.gen(function* lifecycle() {
	const registry = yield* LeaseRegistry;
	const adopted = yield* registry.adopted;
	const state = yield* SynchronizedRef.make<Leasing>({ kind: "accepting", leases: adopted });
	const services = yield* Effect.context<Processes | LeaseRegistry>();

	const watching = Effect.sleep(leaseInterval).pipe(
		Effect.andThen(SynchronizedRef.updateAndGetEffect(state, checked)),
		Effect.repeat({ until: (now) => now.kind === "closing" }),
		Effect.asVoid,
		Effect.provideContext(services),
	);

	const answer: Path["answer"] = (incoming) =>
		Schema.decodeEffect(LeaseRequestJson)(incoming.body).pipe(
			Effect.matchEffect({
				onFailure: () => Effect.succeed(answered(badRequest, "unreadable")),
				onSuccess: (request) =>
					SynchronizedRef.modifyEffect(state, (now) => registered(now, request)).pipe(
						Effect.orDie,
						Effect.map((reply) => answered(statusOf[reply], reply)),
					),
			}),
			Effect.provideContext(services),
		);

	return { path: { answer, method: "POST", path: leasePath } satisfies Path, watching };
});

export { lifecycle };
