import { Array, Effect, Ref, String as Str, pipe } from "effect";
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
	(pinned: boolean, sealed: number): typeof Status.Type => ({
		accounts: { clean: [{ name: "open", vendor: "anthropic" }], sealed: [{ name: "baa", vendor: "anthropic" }] },
		cleared,
		last: { account: "baa", model: "claude-baa", substitute },
		pinned,
		sealed,
		session: SessionId.make(session),
	});

const unanswered =
	"[09:28:38.975] ERROR (#2): RouterUnanswered: phi-router status --port 47498: no router answers there. A protected session starts the router.";

const none = 0;

const one = 1;

/**
 * A router that holds the session's pin and sealed count, records each command, and answers none when `down`. Its
 * last request ran the substitute when `substitute`.
 */
const routerOf = Effect.fnUntraced(function* routerOf(down: boolean, substitute?: boolean) {
	const asked = yield* Ref.make<readonly string[]>([]);
	const pinned = yield* Ref.make(false);
	const sealed = yield* Ref.make(none);

	const ask = (command: string, port: number): Effect.Effect<void, CommandFailed> => {
		const failed = Effect.fail(
			CommandFailed.make({ cause: `${unanswered}\n    at makeClassTrusted (Schema.js:10587:14)\n`, command }),
		);

		const recorded = Ref.update(asked, Array.append(`${command} ${String(port)}`));

		return Effect.andThen(recorded, Effect.when(failed, Effect.succeed(down)));
	};

	const service = Router.of({
		pin: (_session, port) => Effect.andThen(ask("pin", port), Ref.set(pinned, true)),
		start: () => Effect.void,
		status: (_session, port) =>
			Effect.andThen(
				ask("status", port),
				Effect.zipWith(Ref.get(pinned), Ref.get(sealed), reported(substitute === true)),
			),
		unpin: (_session, port) => Effect.andThen(ask("unpin", port), Ref.set(pinned, false)),
	});

	return { asked, sealed, service };
});

type Shown = readonly (readonly [kind: string, text: string])[];

/** The context pi gives the handlers, and each notice and status bar text it showed, in order. */
interface Shows {
	readonly ctx: ShownContext;
	readonly shown: Shown;
}

/**
 * The context of the session, with a UI when `hasUI`, on a model of `provider`.
 *
 * @param {boolean} hasUI Whether pi shows a UI.
 * @param {string} provider The provider of the session's model.
 * @returns {Shows} The context, and what it showed.
 */
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
				shown.push(["status", text ?? ""]);
			},
		},
	};

	return { ctx, shown };
};

const kindsIn = (shown: Shown): readonly string[] =>
	pipe(
		shown,
		Array.map(([kind]) => kind),
	);

const noticesIn = (shown: Shown): Shown =>
	pipe(
		shown,
		Array.filter(([kind]) => kind !== "status"),
	);

it.effect("/phi shows the session's pin, last request, counts and accounts, and asks the router on pi's port", () =>
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
				"phi-router, session pi-session-1\nPin: off\nLast request: baa, model claude-baa\nMessages: 0 sealed, 2 cleared\nClean lane: open\nSealed lane: baa",
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
				"phi-router, session pi-session-1\nPin: off\nLast request: baa, model claude-baa, a substitute for the requested model\nMessages: 0 sealed, 2 cleared\nClean lane: open\nSealed lane: baa",
			],
		]);
	}),
);

it.effect("/phi pin pins the session before it shows the status, and /phi unpin clears it", () =>
	Effect.gen(function* pinned() {
		const router = yield* routerOf(false);
		const { ctx, shown } = contextOf(true);
		const phi = answered(routerPort);

		yield* Effect.provideService(Effect.andThen(phi(" pin ", ctx), phi("unpin", ctx)), Router, router.service);

		const asked = yield* Ref.get(router.asked);

		assert.deepStrictEqual(asked, ["pin 47498", "status 47498", "unpin 47498", "status 47498"]);
		assert.deepStrictEqual(
			pipe(
				noticesIn(shown),
				Array.map(([, text]) => Str.split(text, "\n")[one]),
			),
			["Pin: on, every request runs on the sealed lane", "Pin: off"],
		);
	}),
);

it.effect("/phi with no router answering shows why as an error, from the CLI's RouterUnanswered line", () =>
	Effect.gen(function* down() {
		const router = yield* routerOf(true);
		const { ctx, shown } = contextOf(true);
		const phi = answered(routerPort);

		yield* Effect.provideService(Effect.andThen(phi("", ctx), phi("pin", ctx)), Router, router.service);

		assert.deepStrictEqual(shown, [
			["error", `phi-router status failed: ${unanswered}`],
			["error", `phi-router pin failed: ${unanswered}`],
		]);
	}),
);

it.effect("/phi with a word it does not know shows its usage and asks the router nothing", () =>
	Effect.gen(function* unknown() {
		const router = yield* routerOf(false);
		const { ctx, shown } = contextOf(true);

		yield* Effect.provideService(answered(routerPort)("pinned", ctx), Router, router.service);

		const asked = yield* Ref.get(router.asked);

		assert.deepStrictEqual({ asked, kinds: kindsIn(shown) }, { asked: [], kinds: ["warning"] });
	}),
);

const refused = "phi-router: this session's model is not a phi model, so phi-router does not route it.";

it.effect("/phi on another provider's model pins nothing and says phi-router does not route the session", () =>
	Effect.gen(function* unrouted() {
		const router = yield* routerOf(false);
		const { ctx, shown } = contextOf(true, "anthropic");
		const phi = answered(routerPort);

		yield* Effect.provideService(Effect.andThen(phi("pin", ctx), phi("", ctx)), Router, router.service);

		const asked = yield* Ref.get(router.asked);

		assert.deepStrictEqual(
			{ asked, shown },
			{
				asked: [],
				shown: [
					["warning", refused],
					["warning", refused],
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
