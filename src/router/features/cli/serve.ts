import { Callers, Listener, Proofs, listensOn } from "#router/client/router-port/index.ts";
import { Console, Effect, Layer, Option, Schedule, Schema, Scope } from "effect";
import { Router } from "#router/features/route/index.ts";
import { keyless } from "./no-baa-key.ts";
import { lifecycle } from "#router/features/lifecycle/index.ts";
import { ownVersion } from "./platform.ts";

class NoLeaseHolds extends Schema.TaggedError<NoLeaseHolds, { readonly brand: unique symbol }>()("NoLeaseHolds", {
	port: Schema.Int,
}) {
	public override get message(): string {
		return `phi-router on port ${String(this.port)} stops: no leased instance is alive`;
	}
}

const bindRetry = { schedule: Schedule.spaced("50 millis"), times: 40 } as const;

const serve = Effect.fnUntraced(function* serve(port: number) {
	const version = yield* Effect.option(ownVersion);
	const scope = yield* Scope.make();
	const { on } = yield* Listener;
	const server = yield* Layer.buildWithScope(on(port), scope).pipe(Effect.retry(bindRetry));
	const url = yield* Effect.provideContext(listensOn, server);
	const proof = yield* Proofs.use((proofs) => proofs.row(Number(new URL(url).port), Option.getOrUndefined(version)));
	const { path, watching } = yield* lifecycle;

	const routes = Layer.effectDiscard(Console.log(`phi-router listens on ${url}`)).pipe(
		Layer.provide(Router([path, proof])),
		Layer.provide(Callers.layer),
		Layer.provide(Layer.succeedContext(server)),
	);

	yield* Layer.buildWithScope(routes, scope).pipe(
		Effect.catchTags({ KeyUnreadable: keyless, NoConfigFile: keyless, NoJudge: keyless }),
	);
	yield* watching;

	return yield* NoLeaseHolds.make({ port });
});

export { serve };
