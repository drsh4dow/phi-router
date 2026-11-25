import { Console, Effect, String as Str } from "effect";
import type {
	ExtensionUIContext,
	InputEventResult,
	SessionBeforeCompactResult,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Observe, ShownContext } from "./phi.ts";
import { printedLine, routed } from "./phi.ts";
import type { CommandFailed } from "#shared/cli.ts";
import { Router } from "#pi/client/router.ts";

interface HeldRequestContext {
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly model: { readonly provider: string } | undefined;
	readonly sessionManager: Pick<SessionManager, "getSessionId">;
	readonly ui: Pick<ExtensionUIContext, "notify">;
}

const leaseLeft = (port: number, ctx: HeldRequestContext): Effect.Effect<string, CommandFailed, Router> =>
	Router.use((client) => client.start(ctx.sessionManager.getSessionId(), ctx.cwd, port));

const cleared = (port: number, ctx: HeldRequestContext): Effect.Effect<boolean, never, Router> => {
	if (!routed(ctx)) {
		return Effect.succeed(true);
	}

	const told = (line: string): Effect.Effect<void> => {
		if (ctx.hasUI) {
			return Effect.sync(() => {
				ctx.ui.notify(line, "error");
			});
		}

		return Console.error(line);
	};

	return leaseLeft(port, ctx).pipe(
		Effect.matchEffect({
			onFailure: (failed) => failed.pipe(printedLine, told, Effect.as(false)),
			onSuccess: () => Effect.succeed(true),
		}),
	);
};

const actions: Readonly<Record<"false" | "true", InputEventResult>> = {
	false: { action: "handled" },
	true: { action: "continue" },
};

const promptSent =
	(port: number) =>
	(ctx: HeldRequestContext): Effect.Effect<InputEventResult, never, Router> =>
		Effect.map(cleared(port, ctx), (may) => actions[`${may}`]);

const compactionSent =
	(port: number) =>
	(ctx: HeldRequestContext): Effect.Effect<SessionBeforeCompactResult, never, Router> =>
		Effect.map(cleared(port, ctx), (may) => ({ cancel: !may }));

const shownOnce = (line: string, ctx: HeldRequestContext): Effect.Effect<void> => {
	if (Str.isEmpty(line)) {
		return Effect.void;
	}

	if (ctx.hasUI) {
		return Effect.sync(() => {
			ctx.ui.notify(line, "info");
		});
	}

	return Console.error(line);
};

const sessionLeased =
	(port: number) =>
	(
		atStart: Observe,
		ctx: HeldRequestContext & ShownContext,
	): Effect.Effect<void, never, Effect.Services<ReturnType<Observe>>> =>
		leaseLeft(port, ctx).pipe(
			Effect.flatMap((line) => shownOnce(Str.trim(line), ctx)),
			Effect.andThen(atStart(ctx)),
			Effect.catchTag("CommandFailed", () => Effect.void),
		);

export { compactionSent, promptSent, sessionLeased };

export type { HeldRequestContext };
