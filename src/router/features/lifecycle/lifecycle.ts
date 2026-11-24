import { Array, Effect, Option, Schema, Struct, SynchronizedRef, pipe } from "effect";
import { Lease, LeaseRegistry } from "#router/client/leases.ts";
import type { LeaseReply, LeaseRequest, Outgoing, Path } from "#router/client/router-port/index.ts";
import { LeaseRequestJson, leasePath, statusOf } from "#router/client/router-port/index.ts";
import type { LiveProcess } from "#router/client/processes.ts";
import { Processes } from "#router/client/processes.ts";
import type { RegistryFailed } from "#router/client/leases.ts";

const leaseInterval = "5 seconds";

type Leases = readonly (typeof Lease.Type)[];

type Leasing = { readonly kind: "accepting"; readonly leases: Leases } | { readonly kind: "closing" };

type Registered = readonly [LeaseReply, Leasing];

const sameLease = Schema.toEquivalence(Lease);

const badRequest = 400;

const answered = (status: number, reply: string): Outgoing => ({ body: `{"lease":"${reply}"}`, kind: "whole", status });

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
