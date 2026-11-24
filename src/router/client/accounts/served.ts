import { Context, Effect, Layer, SynchronizedRef } from "effect";
import type { Served } from "./upstream.ts";
import { UserDirectories } from "effect/persistence";
import { configText } from "#router/client/configuration/index.ts";
import { servedBy } from "./upstream.ts";
import { upstreamHttp } from "./http.ts";

/** What the router serves, and the `config.json` text it built that from. */
interface Held {
	readonly text: string;
	readonly served: Served;
}

const kept = (error: { readonly message: string }): Effect.Effect<void> =>
	Effect.logWarning(`phi-router keeps the accounts it serves: ${error.message}`);

/**
 * The accounts the router serves. `served` reads `config.json` on every call and builds the accounts again when its
 * text changed since the call before, so an account `accounts add` writes serves the next request. A text it cannot
 * serve, or a file it cannot read, keeps the accounts it serves, and it tries a changed text once. A request reads
 * `served` once, when it arrives, and walks those accounts to its end. The router fails to start on a file it cannot
 * read or serve (ADR 0008).
 */
class Upstream extends Context.Service<Upstream, { readonly served: Effect.Effect<Served> }>()(
	"phi-router/router/client/accounts/served/Upstream",
) {
	public static readonly layer = Layer.effect(
		Upstream,
		Effect.gen(function* make() {
			const text = yield* configText;
			const held = yield* SynchronizedRef.make<Held>({ served: yield* servedBy(text), text });

			const context = yield* Effect.context<
				Effect.Services<typeof configText> | Effect.Services<ReturnType<typeof servedBy>>
			>();

			const served = SynchronizedRef.modifyEffect(held, (now) =>
				Effect.gen(function* reread() {
					const read = yield* configText;

					if (read === now.text) {
						return now;
					}

					const built = yield* servedBy(read).pipe(
						Effect.tapError(kept),
						Effect.orElseSucceed(() => now.served),
					);

					return { served: built, text: read };
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
