import { Array, Config, Effect, Option, String as Str, pipe } from "effect";
import type { CommandFailed, StatuslineJson } from "#shared/cli.ts";
import { SessionId, phiCommand } from "#shared/cli.ts";
import { Router } from "#pi/client/router.ts";
import { piWire } from "#shared/pi.ts";

const unrouted = `phi-router: this session's model is not a ${piWire.provider} model, so phi-router does not route it.`;

const statusBarEntry = "phi";

const noLine = Option.getOrUndefined(Option.none<string>());

const usage = `/${phiCommand.name} ${phiCommand.setup} sets up phi-router, /${phiCommand.name} shows this session's routing. To run the session on the BAA account, switch the model to ${piWire.models.sealed}.`;

interface ShownContext {
	readonly hasUI: boolean;
	readonly model: { readonly provider: string } | undefined;
	readonly sessionManager: { readonly getSessionId: () => string };
	readonly ui: {
		readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
		readonly setStatus: (key: string, text: string | undefined) => void;
	};
}

const printedLine: (failed: Pick<CommandFailed, "cause">) => string = (failed) =>
	pipe(
		Str.split(String(failed.cause), "\n"),
		Array.map(Str.trim),
		Array.findFirst(Str.isNonEmpty),
		Option.getOrElse(() => "it printed nothing"),
	);

const failureText: (failed: Pick<CommandFailed, "cause" | "command">) => string = (failed) =>
	`phi-router ${failed.command} failed: ${printedLine(failed)}`;

const rootSession: Effect.Effect<Option.Option<string>> = Effect.orDie(
	Config.option(Config.String(piWire.sessionVariable)),
);

const sessionOf = (ctx: Pick<ShownContext, "sessionManager">): Effect.Effect<typeof SessionId.Type> =>
	rootSession.pipe(
		Effect.map(Option.getOrElse(() => ctx.sessionManager.getSessionId())),
		Effect.map((session) => SessionId.make(session)),
	);

const routed = (ctx: Pick<ShownContext, "model">): boolean =>
	pipe(
		Option.fromNullishOr(ctx.model),
		Option.exists(({ provider }) => provider === piWire.provider),
	);

const shownOf = (port: number, ctx: ShownContext): Effect.Effect<typeof StatuslineJson.Type, CommandFailed, Router> =>
	Effect.flatMap(sessionOf(ctx), (session) => Router.use((client) => client.statusline(session, port)));

const answered: (port: number) => (words: string, ctx: ShownContext) => Effect.Effect<void, never, Router> =
	(port) => (words, ctx) => {
		if (!routed(ctx)) {
			return Effect.sync(() => {
				ctx.ui.notify(unrouted, "warning");
			});
		}

		if (Str.isNonEmpty(Str.trim(words))) {
			return Effect.sync(() => {
				ctx.ui.notify(usage, "warning");
			});
		}

		return shownOf(port, ctx).pipe(
			Effect.match({
				onFailure: (failed) => {
					ctx.ui.notify(failureText(failed), "error");
				},
				onSuccess: ({ line, reply }) => {
					Option.match(Option.fromUndefinedOr(line), {
						onNone: () => {
							ctx.ui.notify(reply, "error");
						},
						onSome: (shown) => {
							ctx.ui.setStatus(statusBarEntry, shown);
							ctx.ui.notify(`phi-router, ${reply}`, "info");
						},
					});
				},
			}),
		);
	};

type Observe = (ctx: ShownContext) => Effect.Effect<void, never, Router>;

const statusShown =
	(port: number): Observe =>
	(ctx) =>
		Effect.gen(function* refreshed() {
			if (!routed(ctx)) {
				ctx.ui.setStatus(statusBarEntry, noLine);

				return;
			}

			const { line, reply } = yield* shownOf(port, ctx);

			ctx.ui.setStatus(statusBarEntry, line ?? reply);
		}).pipe(
			Effect.catchTag("CommandFailed", (failed) =>
				Effect.sync(() => {
					ctx.ui.setStatus(statusBarEntry, failureText(failed));
				}),
			),
			Effect.when(Effect.succeed(ctx.hasUI)),
			Effect.asVoid,
		);

export { answered, failureText, printedLine, rootSession, routed, sessionOf, statusShown, usage };

export type { Observe, ShownContext };
