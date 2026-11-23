import { Console, Effect, Layer, Schedule, Schema, Scope } from "effect";
import { Listener, listensOn } from "#router/client/server.ts";
import { Callers } from "#router/client/callers.ts";
import { Proofs } from "#router/client/proof.ts";
import { Router } from "#router/features/route/index.ts";
import { lifecycle } from "#router/features/lifecycle/index.ts";

/** The lease check found no lease that holds, so the router stops. */
class NoLeaseHolds extends Schema.TaggedError<NoLeaseHolds, { readonly brand: unique symbol }>()("NoLeaseHolds", {
	port: Schema.Int,
}) {
	public override get message(): string {
		return `phi-router on port ${String(this.port)} stops: no leased instance is alive`;
	}
}

/** A router that is closing holds the port until its process ends, so a new one waits for the port. */
const bindRetry = { schedule: Schedule.spaced("50 millis"), times: 40 } as const;

/**
 * Runs the router until its lease check finds no lease that holds, and prints `phi-router listens on
 * http://127.0.0.1:<port>` once its routes answer. A caller that passed port 0 reads the port from that line. It binds
 * the port first, so a second `serve` on the port fails before it reads or writes any state, then reads its secret,
 * writing a fresh one when the state folder holds none, then adopts the lease registry, then builds the routes, which
 * read `config.json` and run the key commands. A missing or unreadable `config.json`, a key source that gives no key,
 * or a port still in use after 2 s fails the command with that error.
 *
 * The router's scope is never closed. Once the check stops accepting, `serve` fails with `NoLeaseHolds`, the runtime
 * ends the process at once, and the port is free only then. A graceful close would free the port first and could
 * wait without bound on a request that never finishes (ADR 0005).
 */
const serve = Effect.fnUntraced(function* serve(port: number) {
	const scope = yield* Scope.make();
	const { on } = yield* Listener;
	const server = yield* Layer.buildWithScope(on(port), scope).pipe(Effect.retry(bindRetry));
	const url = yield* Effect.provideContext(listensOn, server);
	const proof = yield* Proofs.use((proofs) => proofs.row(Number(new URL(url).port)));
	const { path, watching } = yield* lifecycle;

	const routes = Layer.effectDiscard(Console.log(`phi-router listens on ${url}`)).pipe(
		Layer.provide(Router([path, proof])),
		Layer.provide(Callers.layer),
		Layer.provide(Layer.succeedContext(server)),
	);

	yield* Layer.buildWithScope(routes, scope);
	yield* watching;

	return yield* NoLeaseHolds.make({ port });
});

export { serve };
