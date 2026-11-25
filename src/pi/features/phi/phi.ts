import { Array, Effect, Option, Record, Ref, String as Str, pipe } from "effect";
import type { CommandFailed, Status } from "#shared/cli.ts";
import { SessionId, phiCommand } from "#shared/cli.ts";
import { Router } from "#pi/client/router.ts";
import { piWire } from "#shared/pi.ts";

type Reported = Omit<typeof Status.Type, "session"> & { readonly session: string };

const unrouted = `phi-router: this session's model is not a ${piWire.provider} model, so phi-router does not route it.`;

const statusBarEntry = "phi";

const noLine = Option.getOrUndefined(Option.none<string>());

const noneSealed = 0;

const oneMessage = 1;

const usage = `/${phiCommand.name} ${phiCommand.setup} sets up phi-router, /${phiCommand.name} shows this session's routing. To run the session on the BAA account, switch the model to ${piWire.models.sealed}.`;

type Shows = (status: Reported) => string;

const ranOn = (last: NonNullable<Reported["last"]>): string => {
	const ran = `${last.account}, model ${last.model}`;

	if (last.substitute) {
		return `${ran}, a substitute for the requested model`;
	}

	return ran;
};

const lastOf: Shows = (status) =>
	pipe(Option.fromNullishOr(status.last), Option.match({ onNone: () => "none yet", onSome: ranOn }));

const namesOf = (accounts: Reported["accounts"]["clean"]): string =>
	pipe(
		accounts,
		Array.map(({ name }) => name),
		Array.join(", "),
		Option.liftPredicate(Str.isNonEmpty),
		Option.getOrElse(() => "none"),
	);

const statusText: Shows = (status) =>
	Array.join(
		[
			`phi-router, session ${status.session}`,
			`Last request: ${lastOf(status)}`,
			`Messages: ${String(status.sealed)} sealed, ${String(status.cleared)} cleared`,
			`Clean lane: ${namesOf(status.accounts.clean)}`,
			`Sealed lane: ${namesOf(status.accounts.sealed)}`,
		],
		"\n",
	);

const statusLine: Shows = (status) =>
	Array.join(["phi", lastOf(status), `${String(status.sealed)} sealed`, `${String(status.cleared)} cleared`], " · ");

const messagesIn = (count: number): string => {
	if (count === oneMessage) {
		return "1 message";
	}

	return `${String(count)} messages`;
};

const sealNotice: (sealed: { readonly newlySealed: number; readonly status: Reported }) => string = (sealed) =>
	`phi-router: ${messagesIn(sealed.newlySealed)} held patient identifiers and ran only on the BAA account. Last request: ${lastOf(sealed.status)}.`;

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

const sessionOf: (ctx: ShownContext) => typeof SessionId.Type = (ctx) =>
	SessionId.make(ctx.sessionManager.getSessionId());

const routed = (ctx: Pick<ShownContext, "model">): boolean =>
	pipe(
		Option.fromNullishOr(ctx.model),
		Option.exists(({ provider }) => provider === piWire.provider),
	);

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

		return Router.use((client) => client.status(sessionOf(ctx), port)).pipe(
			Effect.match({
				onFailure: (failed) => {
					ctx.ui.notify(failureText(failed), "error");
				},
				onSuccess: (status) => {
					ctx.ui.setStatus(statusBarEntry, statusLine(status));
					ctx.ui.notify(statusText(status), "info");
				},
			}),
		);
	};

type Observe = (ctx: ShownContext) => Effect.Effect<void, never, Router>;

const observerOn = Effect.fnUntraced(function* observerOn(port: number) {
	const seen = yield* Ref.make<Readonly<Record<string, number>>>({});

	const observe =
		(announce: boolean): Observe =>
		(ctx) =>
			Effect.gen(function* refreshed() {
				if (!routed(ctx)) {
					ctx.ui.setStatus(statusBarEntry, noLine);

					return;
				}

				const session = sessionOf(ctx);
				const status = yield* Router.use((client) => client.status(session, port));
				const shown = yield* Ref.getAndUpdate(seen, Record.set(session, status.sealed));

				const before = Option.orElse(Record.get(shown, session), () =>
					Option.liftPredicate(noneSealed, () => announce),
				);

				ctx.ui.setStatus(statusBarEntry, statusLine(status));

				if (Option.isSome(before) && status.sealed > before.value) {
					ctx.ui.notify(sealNotice({ newlySealed: status.sealed - before.value, status }), "warning");
				}
			}).pipe(
				Effect.catchTag("CommandFailed", (failed) =>
					Effect.sync(() => {
						ctx.ui.setStatus(statusBarEntry, failureText(failed));
					}),
				),
				Effect.when(Effect.succeed(ctx.hasUI)),
				Effect.asVoid,
			);

	return { afterTurn: observe(true), atStart: observe(false) };
});

export { answered, observerOn, printedLine, routed, usage };

export type { Observe, ShownContext };
