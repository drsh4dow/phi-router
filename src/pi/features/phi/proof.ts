import { Console, Effect } from "effect";
import type {
	ExtensionUIContext,
	InputEventResult,
	SessionBeforeCompactResult,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Router } from "#pi/client/router.ts";
import { routed } from "./phi.ts";

/** What a hook that may hold back a request reads of pi's context. */
interface SendContext {
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly model: { readonly provider: string } | undefined;
	readonly sessionManager: Pick<SessionManager, "getSessionId">;
	readonly ui: Pick<ExtensionUIContext, "notify">;
}

/**
 * Whether pi may send `what` of the session in `ctx` to the router on `port`. A request of another provider than `phi`
 * may go. One of `phi` may once the lease is left again, which first makes the listener on the port prove it is this
 * user's router (ADR 0002) and starts a router when none runs. When it may not, the developer reads why: in pi's
 * interface, or on stderr in print mode, which has none.
 *
 * @param {number} port The router's port.
 * @param {string} what What pi is about to send, as the developer reads it.
 * @param {SendContext} ctx The session, its model and pi's interface.
 * @returns {Effect.Effect<boolean, never, Router>} Whether pi may send it.
 */
const cleared = (port: number, what: string, ctx: SendContext): Effect.Effect<boolean, never, Router> => {
	if (!routed(ctx)) {
		return Effect.succeed(true);
	}

	const line = `phi-router: pi did not send ${what}, since port ${String(port)} does not hold your router.`;

	const told = Effect.suspend(() => {
		if (ctx.hasUI) {
			return Effect.sync(() => {
				ctx.ui.notify(line, "error");
			});
		}

		return Console.error(line);
	});

	return Router.use((client) => client.start(ctx.sessionManager.getSessionId(), ctx.cwd, port)).pipe(
		Effect.matchEffect({ onFailure: () => Effect.as(told, false), onSuccess: () => Effect.succeed(true) }),
	);
};

const actions: Readonly<Record<"false" | "true", InputEventResult>> = {
	false: { action: "handled" },
	true: { action: "continue" },
};

/**
 * The input hook's answer for a router on `port`: pi sends the prompt only when `cleared` lets it.
 *
 * @param {number} port The router's port.
 * @returns {Function} The answer for the session, its model and pi's interface in `ctx`.
 */
const promptSent =
	(port: number) =>
	(ctx: SendContext): Effect.Effect<InputEventResult, never, Router> =>
		Effect.map(cleared(port, "this prompt", ctx), (may) => actions[`${may}`]);

/**
 * The compaction hook's answer for a router on `port`: pi sends the session to be summed up only when `cleared` lets it.
 *
 * @param {number} port The router's port.
 * @returns {Function} The answer for the session, its model and pi's interface in `ctx`.
 */
const compactionSent =
	(port: number) =>
	(ctx: SendContext): Effect.Effect<SessionBeforeCompactResult, never, Router> =>
		Effect.map(cleared(port, "this compaction", ctx), (may) => ({ cancel: !may }));

export { compactionSent, promptSent };
