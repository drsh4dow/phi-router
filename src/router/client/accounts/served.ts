import { Context, Effect, Layer, SynchronizedRef } from "effect";
import type { Served } from "./upstream.ts";
import { UserDirectories } from "effect/persistence";
import { configText } from "#router/client/configuration/index.ts";
import { servedBy } from "./upstream.ts";
import { upstreamHttp } from "./http.ts";

interface Serving {
	readonly builtFrom: string;
	readonly served: Served;
}

const kept = (error: { readonly message: string }): Effect.Effect<void> =>
	Effect.logWarning(`phi-router keeps the accounts it serves: ${error.message}`);

class Upstream extends Context.Service<Upstream, { readonly served: Effect.Effect<Served> }>()(
	"phi-router/router/client/accounts/served/Upstream",
) {
	public static readonly layer = Layer.effect(
		Upstream,
		Effect.gen(function* make() {
			const text = yield* configText;
			const held = yield* SynchronizedRef.make<Serving>({ builtFrom: text, served: yield* servedBy(text) });

			const context = yield* Effect.context<
				Effect.Services<typeof configText> | Effect.Services<ReturnType<typeof servedBy>>
			>();

			const served = SynchronizedRef.modifyEffect(held, (now) =>
				Effect.gen(function* reread() {
					const read = yield* configText;

					if (read === now.builtFrom) {
						return now;
					}

					const built = yield* servedBy(read).pipe(
						Effect.tapError(kept),
						Effect.orElseSucceed(() => now.served),
					);

					return { builtFrom: read, served: built };
				}).pipe(
					Effect.tapError(kept),
					Effect.orElseSucceed(() => now),
					Effect.map((next) => [next.served, next] as const),
					Effect.provideContext(context),
				),
			);

			return Upstream.of({ served });
		}),
	).pipe(Layer.provide(Layer.merge(upstreamHttp, UserDirectories.layer)));
}

export { Upstream };
