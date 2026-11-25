import { Array, Effect, Ref, pipe } from "effect";
import { CommandFailed, SessionId } from "#shared/cli.ts";
import { answered, observerOn } from "#pi/features/phi/phi.ts";
import { assert, it } from "@effect/vitest";
import { Router } from "#pi/client/router.ts";
import type { ShownContext } from "#pi/features/phi/phi.ts";
import type { Status } from "#shared/cli.ts";

const session = "pi-session-1";

const routerPort = 47_498;

const cleared = 2;

const reported =
	(substitute: boolean) =>
	(sealed: number): typeof Status.Type => ({
		accounts: { clean: [{ name: "open", vendor: "anthropic" }], sealed: [{ name: "baa", vendor: "anthropic" }] },
		cleared,
		last: { account: "baa", model: "claude-baa", substitute },
		sealed,
		session: SessionId.make(session),
	});

const unanswered =
	"[09:28:38.975] ERROR (#2): RouterUnanswered: phi-router status --port 47498: no router answers there. A protected session starts the router.";

const none = 0;

const one = 1;

const routerOf = Effect.fnUntraced(function* routerOf(down: boolean, substitute?: boolean) {
	const asked = yield* Ref.make<readonly string[]>([]);
	const sealed = yield* Ref.make(none);

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
		start: () => Effect.void,
		status: (_session, port) =>
			Effect.andThen(ask("status", port), Effect.map(Ref.get(sealed), reported(substitute === true))),
	});

	return { asked, sealed, service };
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

		yield* Effect.provideService(answered(routerPort)("", ctx), Router, router.service);

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

		yield* Effect.provideService(answered(routerPort)("", ctx), Router, router.service);

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

		yield* Effect.provideService(phi("", ctx), Router, router.service);

		assert.deepStrictEqual(shown, [["error", `phi-router status failed: ${unanswered}`]]);
	}),
);

it.effect(
	"/phi pin, like any word /phi does not know, shows the usage, which names phi/sealed, and asks the router nothing",
	() =>
		Effect.gen(function* unknown() {
			const router = yield* routerOf(false);
			const { ctx, shown } = contextOf(true);

			yield* Effect.provideService(answered(routerPort)(" pin ", ctx), Router, router.service);

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

			yield* Effect.provideService(all, Router, router.service);

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
		yield* Effect.provideService(Effect.andThen(atStart(ctx), turn), Router, router.service);
		yield* Ref.set(router.sealed, sealedBefore + one);
		yield* Effect.provideService(Effect.andThen(turn, turn), Router, router.service);

		assert.deepStrictEqual(noticesIn(shown), [
			[
				"warning",
				"phi-router: 1 message held patient identifiers and ran only on the BAA account. Last request: baa, model claude-baa.",
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
		yield* Effect.provideService(afterTurn(ctx), Router, router.service);

		assert.deepStrictEqual(noticesIn(shown), [
			[
				"warning",
				"phi-router: 2 messages held patient identifiers and ran only on the BAA account. Last request: baa, model claude-baa.",
			],
		]);
	}),
);

it.effect("with no UI, as in print mode, a turn asks the router nothing", () =>
	Effect.gen(function* printMode() {
		const router = yield* routerOf(false);
		const { ctx } = contextOf(false);
		const { afterTurn } = yield* observerOn(routerPort);

		yield* Effect.provideService(afterTurn(ctx), Router, router.service);

		const asked = yield* Ref.get(router.asked);

		assert.deepStrictEqual(asked, []);
	}),
);

it.effect("with no router answering after a turn, the status bar says why", () =>
	Effect.gen(function* downAfterTurn() {
		const router = yield* routerOf(true);
		const { ctx, shown } = contextOf(true);
		const { afterTurn } = yield* observerOn(routerPort);

		yield* Effect.provideService(afterTurn(ctx), Router, router.service);

		assert.deepStrictEqual(shown, [["status", `phi-router status failed: ${unanswered}`]]);
	}),
);
