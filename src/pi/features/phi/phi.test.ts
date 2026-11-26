import { Array, DateTime, Effect, Option, Ref, String as Str, Struct, flow, pipe } from "effect";
import { CommandFailed, SessionId } from "#shared/cli.ts";
import { answered, observerOn } from "#pi/features/phi/phi.ts";
import { assert, it } from "@effect/vitest";
import { Router } from "#pi/client/router.ts";
import type { ShownContext } from "#pi/features/phi/phi.ts";
import type { Status } from "#shared/cli.ts";
import { TestClock } from "effect/testing";

const session = "pi-session-1";

const utc = DateTime.zoneMakeNamedUnsafe("UTC");

const routerPort = 47_498;

const cleared = 2;

interface Pool {
	readonly overflowed: number;
	readonly back?: string;
}

const open = { name: "open", vendor: "anthropic" } as const;

const reported =
	(substitute: boolean) =>
	(now: { readonly pool: Pool; readonly sealed: number }): typeof Status.Type => ({
		accounts: {
			clean: [
				Option.match(Option.fromUndefinedOr(now.pool.back), {
					onNone: () => open,
					onSome: (rateLimitedUntil) => Struct.assign(open, { rateLimitedUntil }),
				}),
			],
			sealed: [{ name: "baa", vendor: "anthropic" }],
		},
		cleared,
		last: { account: "baa", model: "claude-baa", substitute },
		overflowed: now.pool.overflowed,
		sealed: now.sealed,
		session: SessionId.make(session),
	});

const unanswered =
	"[09:28:38.975] ERROR (#2): RouterUnanswered: phi-router status --port 47498: no router answers there. A protected session starts the router.";

const none = 0;

const one = 1;

const routerOf = Effect.fnUntraced(function* routerOf(down: boolean, substitute?: boolean) {
	const asked = yield* Ref.make<readonly string[]>([]);
	const sealed = yield* Ref.make(none);
	const pool = yield* Ref.make<Pool>({ overflowed: none });

	const ask = (command: string, port: number): Effect.Effect<void, CommandFailed> => {
		const failed = Effect.fail(
			CommandFailed.make({ cause: `${unanswered}\n    at makeClassTrusted (Schema.js:10587:14)\n`, command }),
		);

		const recorded = Ref.update(asked, Array.append(`${command} ${String(port)}`));

		return Effect.andThen(recorded, Effect.when(failed, Effect.succeed(down)));
	};

	const service = Router.of({
		models: Effect.succeed({}),
		setUp: () => Effect.die("/phi sets nothing up"),
		setupStep: () => Effect.die("/phi sets nothing up"),
		start: () => Effect.succeed(""),
		status: (_session, port) =>
			Effect.andThen(
				ask("status", port),
				Effect.gen(function* statusNow() {
					return reported(substitute === true)({ pool: yield* Ref.get(pool), sealed: yield* Ref.get(sealed) });
				}),
			),
	});

	return { asked, pool, sealed, service };
});

const noEntry = "no entry";

type Shown = readonly (readonly [kind: string, text: string])[];

interface Shows {
	readonly ctx: ShownContext;
	readonly shown: Shown;
}

const contextOf = (hasUI: boolean, provider = "phi"): Shows => {
	const shown: (readonly [string, string])[] = [];

	const ctx: ShownContext = {
		hasUI,
		model: { provider },
		sessionManager: { getSessionId: (): string => session },
		ui: {
			notify: (text, kind = "info"): void => {
				shown.push([kind, text]);
			},
			setStatus: (_key, text): void => {
				shown.push(["status", text ?? noEntry]);
			},
		},
	};

	return { ctx, shown };
};

const noticesIn = (shown: Shown): Shown =>
	pipe(
		shown,
		Array.filter(([kind]) => kind !== "status"),
	);

it.effect("/phi shows the session's last request, counts and accounts, and asks the router on pi's port", () =>
	Effect.gen(function* shownStatus() {
		const router = yield* routerOf(false);
		const { ctx, shown } = contextOf(true);

		yield* Effect.provideService(answered(routerPort)("", ctx), Router, router.service).pipe(
			Effect.provideService(DateTime.CurrentTimeZone, utc),
		);

		const asked = yield* Ref.get(router.asked);

		assert.deepStrictEqual(asked, ["status 47498"]);
		assert.deepStrictEqual(shown, [
			["status", "phi · baa, model claude-baa · 0 sealed · 2 cleared"],
			[
				"info",
				"phi-router, session pi-session-1\nLast request: baa, model claude-baa\nMessages: 0 sealed, 2 cleared\nClean lane: open\nSealed lane: baa",
			],
		]);
	}),
);

it.effect("/phi and the status bar say the last request's model was a substitute when it was", () =>
	Effect.gen(function* substituted() {
		const router = yield* routerOf(false, true);
		const { ctx, shown } = contextOf(true);

		yield* Effect.provideService(answered(routerPort)("", ctx), Router, router.service).pipe(
			Effect.provideService(DateTime.CurrentTimeZone, utc),
		);

		assert.deepStrictEqual(shown, [
			["status", "phi · baa, model claude-baa, a substitute for the requested model · 0 sealed · 2 cleared"],
			[
				"info",
				"phi-router, session pi-session-1\nLast request: baa, model claude-baa, a substitute for the requested model\nMessages: 0 sealed, 2 cleared\nClean lane: open\nSealed lane: baa",
			],
		]);
	}),
);

it.effect("/phi with no router answering shows why as an error, from the CLI's RouterUnanswered line", () =>
	Effect.gen(function* down() {
		const router = yield* routerOf(true);
		const { ctx, shown } = contextOf(true);
		const phi = answered(routerPort);

		yield* Effect.provideService(phi("", ctx), Router, router.service).pipe(
			Effect.provideService(DateTime.CurrentTimeZone, utc),
		);

		assert.deepStrictEqual(shown, [["error", `phi-router status failed: ${unanswered}`]]);
	}),
);

it.effect(
	"/phi pin, like any word /phi does not know, shows the usage, which names phi/sealed, and asks the router nothing",
	() =>
		Effect.gen(function* unknown() {
			const router = yield* routerOf(false);
			const { ctx, shown } = contextOf(true);

			yield* Effect.provideService(answered(routerPort)(" pin ", ctx), Router, router.service).pipe(
				Effect.provideService(DateTime.CurrentTimeZone, utc),
			);

			const asked = yield* Ref.get(router.asked);

			assert.deepStrictEqual(
				{ asked, shown },
				{
					asked: [],
					shown: [
						[
							"warning",
							"/phi setup sets up phi-router, /phi shows this session's routing. To run the session on the BAA account, switch the model to phi/sealed.",
						],
					],
				},
			);
		}),
);

const refused = "phi-router: this session's model is not a phi model, so phi-router does not route it.";

it.effect(
	"on another provider's model /phi says phi-router does not route it, the status bar shows no phi line, and the router is asked nothing",
	() =>
		Effect.gen(function* unrouted() {
			const router = yield* routerOf(false);
			const { ctx, shown } = contextOf(true, "anthropic");
			const phi = answered(routerPort);
			const { afterTurn, atStart } = yield* observerOn(routerPort);
			const all = Effect.all([phi("pin", ctx), phi("", ctx), atStart(ctx), afterTurn(ctx)], { concurrency: 1 });

			yield* Effect.provideService(all, Router, router.service).pipe(
				Effect.provideService(DateTime.CurrentTimeZone, utc),
			);

			const asked = yield* Ref.get(router.asked);

			assert.deepStrictEqual(
				{ asked, shown },
				{
					asked: [],
					shown: [
						["warning", refused],
						["warning", refused],
						["status", noEntry],
						["status", noEntry],
					],
				},
			);
		}),
);

const sealedBefore = 3;

it.effect("after each turn the status bar shows the last request, and a turn that sealed shows a notice once", () =>
	Effect.gen(function* turns() {
		const router = yield* routerOf(false);
		const { ctx, shown } = contextOf(true);
		const { afterTurn, atStart } = yield* observerOn(routerPort);
		const turn = afterTurn(ctx);

		yield* Ref.set(router.sealed, sealedBefore);
		yield* Effect.provideService(Effect.andThen(atStart(ctx), turn), Router, router.service).pipe(
			Effect.provideService(DateTime.CurrentTimeZone, utc),
		);
		yield* Ref.set(router.sealed, sealedBefore + one);
		yield* Effect.provideService(Effect.andThen(turn, turn), Router, router.service).pipe(
			Effect.provideService(DateTime.CurrentTimeZone, utc),
		);

		assert.deepStrictEqual(noticesIn(shown), [
			[
				"warning",
				"phi-router: 1 message held patient identifiers. The open account sees a handle in place of each. Last request: baa, model claude-baa.",
			],
		]);
	}),
);

it.effect("a turn that sealed in a session pi has not shown yet is announced from none", () =>
	Effect.gen(function* firstTurn() {
		const router = yield* routerOf(false);
		const { ctx, shown } = contextOf(true);
		const { afterTurn } = yield* observerOn(routerPort);

		yield* Ref.set(router.sealed, cleared);
		yield* Effect.provideService(afterTurn(ctx), Router, router.service).pipe(
			Effect.provideService(DateTime.CurrentTimeZone, utc),
		);

		assert.deepStrictEqual(noticesIn(shown), [
			[
				"warning",
				"phi-router: 2 messages held patient identifiers. The open account sees a handle in place of each. Last request: baa, model claude-baa.",
			],
		]);
	}),
);

it.effect("with no UI, as in print mode, a turn asks the router nothing", () =>
	Effect.gen(function* printMode() {
		const router = yield* routerOf(false);
		const { ctx } = contextOf(false);
		const { afterTurn } = yield* observerOn(routerPort);

		yield* Effect.provideService(afterTurn(ctx), Router, router.service).pipe(
			Effect.provideService(DateTime.CurrentTimeZone, utc),
		);

		const asked = yield* Ref.get(router.asked);

		assert.deepStrictEqual(asked, []);
	}),
);

it.effect("with no router answering after a turn, the status bar says why", () =>
	Effect.gen(function* downAfterTurn() {
		const router = yield* routerOf(true);
		const { ctx, shown } = contextOf(true);
		const { afterTurn } = yield* observerOn(routerPort);

		yield* Effect.provideService(afterTurn(ctx), Router, router.service).pipe(
			Effect.provideService(DateTime.CurrentTimeZone, utc),
		);

		assert.deepStrictEqual(shown, [["status", `phi-router status failed: ${unanswered}`]]);
	}),
);

const at = (time: string): string => `2026-05-28T${time}:00.000Z`;

const millisAt = flow(at, DateTime.makeUnsafe, DateTime.toEpochMillis);

it.effect("/phi shows an open account the clean lane skips with the time its rate limit ends", () =>
	Effect.gen(function* stamped() {
		const router = yield* routerOf(false);
		const { ctx, shown } = contextOf(true);

		yield* Ref.set(router.pool, { back: at("14:30"), overflowed: none });
		yield* Effect.provideService(answered(routerPort)("", ctx), Router, router.service).pipe(
			Effect.provideService(DateTime.CurrentTimeZone, utc),
		);

		assert.deepStrictEqual(
			pipe(
				noticesIn(shown),
				Array.map(([, text]) => Array.findFirst(Str.split(text, "\n"), Str.startsWith("Clean lane"))),
			),
			[Option.some("Clean lane: open (rate-limited until 14:30)")],
		);
	}),
);

const overflowNotice = (why: string, requests: string): string =>
	`phi-router: your subscription ${why}, so ${requests} ran on your BAA account. Add another subscription: npx phi-router accounts add`;

it.effect(
	"a turn whose requests overflowed to the BAA account says why once per rate-limit window, and once per 30 minutes when the subscription did not answer",
	() =>
		Effect.gen(function* overflow() {
			const router = yield* routerOf(false);
			const { ctx, shown } = contextOf(true);
			const { afterTurn, atStart } = yield* observerOn(routerPort);

			const turn = (time: string, pool: Pool): Effect.Effect<void> =>
				Effect.gen(function* turned() {
					yield* TestClock.setTime(millisAt(time));
					yield* Ref.set(router.pool, pool);
					yield* Effect.provideService(afterTurn(ctx), Router, router.service).pipe(
						Effect.provideService(DateTime.CurrentTimeZone, utc),
					);
				});

			yield* Effect.provideService(atStart(ctx), Router, router.service).pipe(
				Effect.provideService(DateTime.CurrentTimeZone, utc),
			);
			yield* turn("14:00", { back: at("14:30"), overflowed: 2 });
			yield* turn("14:10", { back: at("14:30"), overflowed: 5 });
			yield* turn("14:31", { back: at("15:01"), overflowed: 6 });
			yield* turn("15:30", { overflowed: 7 });
			yield* turn("15:50", { overflowed: 8 });
			yield* turn("16:01", { overflowed: 9 });

			assert.deepStrictEqual(noticesIn(shown), [
				["warning", overflowNotice("is rate-limited until 14:30", "2 requests")],
				["warning", overflowNotice("is rate-limited until 15:01", "1 request")],
				["warning", overflowNotice("did not answer", "1 request")],
				["warning", overflowNotice("did not answer", "1 request")],
			]);
		}),
);
