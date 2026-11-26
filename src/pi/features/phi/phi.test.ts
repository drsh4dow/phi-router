import { Array, Effect, Ref } from "effect";
import { answered, statusShown } from "#pi/features/phi/phi.ts";
import { assert, it } from "@effect/vitest";
import { CommandFailed } from "#shared/cli.ts";
import { Router } from "#pi/client/router.ts";
import type { ShownContext } from "#pi/features/phi/phi.ts";
import type { StatuslineJson } from "#shared/cli.ts";

const session = "pi-session-1";

const routerPort = 47_498;

const marked = "phi · baa · 1 sealed · 2 cleared · 1 pinned run · 1 withheld · overflow till 14:30 · 0.6.0 pending";

const reply =
	"session pi-session-1\nLast request: baa, model claude-baa\nMessages: 1 sealed, 2 cleared\nPinned subagent: 1 run, 5 rewrites, 1 answer withheld\nClean lane: open (rate-limited, tried again at 14:30)\nSealed lane: baa\nOverflow: your subscription hit its rate limit, so 2 requests ran on your BAA account. phi-router tries it again at 14:30. Add another subscription: npx phi-router accounts add\nphi-router 0.6.0 is installed. Your open windows still run 0.5.1 until you close them all.";

const unanswered =
	"[09:28:38.975] ERROR (#2): RouterUnanswered: phi-router statusline: no router answers there. A protected session starts the router.";

const routerOf = Effect.fnUntraced(function* routerOf(shown: typeof StatuslineJson.Type | "fails") {
	const asked = yield* Ref.make<readonly string[]>([]);

	const failed = CommandFailed.make({
		cause: `${unanswered}\n    at makeClassTrusted (Schema.js:10587:14)\n`,
		command: "statusline",
	});

	const answer = Effect.suspend(() => {
		if (shown === "fails") {
			return Effect.fail(failed);
		}

		return Effect.succeed(shown);
	});

	const service = Router.of({
		answerCheck: () => Effect.die("/phi checks no answer"),
		models: Effect.succeed({}),
		setUp: () => Effect.die("/phi sets nothing up"),
		setupStep: () => Effect.die("/phi sets nothing up"),
		start: () => Effect.void,
		statusline: (asking, port) => {
			const line = `statusline ${asking} ${String(port)}`;

			return Effect.andThen(Ref.update(asked, Array.append(line)), answer);
		},
	});

	return { asked, service };
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

it.effect("/phi shows the router's full status, and the status bar its line, asking for the session on pi's port", () =>
	Effect.gen(function* shownStatus() {
		const router = yield* routerOf({ line: marked, reply });
		const { ctx, shown } = contextOf(true);

		yield* Effect.provideService(answered(routerPort)("", ctx), Router, router.service);

		const asked = yield* Ref.get(router.asked);

		assert.deepStrictEqual(
			{ asked, shown },
			{
				asked: [`statusline ${session} ${String(routerPort)}`],
				shown: [
					["status", marked],
					["info", `phi-router, ${reply}`],
				],
			},
		);
	}),
);

it.effect(
	"a turn's end and a session's start put the seal, overflow, withheld and version marks in the status bar, and show no notice",
	() =>
		Effect.gen(function* quiet() {
			const router = yield* routerOf({ line: marked, reply });
			const { ctx, shown } = contextOf(true);
			const show = statusShown(routerPort);

			const both = Effect.all([show(ctx), show(ctx)], { concurrency: 1, discard: true });

			yield* Effect.provideService(both, Router, router.service);

			assert.deepStrictEqual(shown, [
				["status", marked],
				["status", marked],
			]);
		}),
);

it.effect("with no UI, as in print mode, a turn asks the router nothing", () =>
	Effect.gen(function* printMode() {
		const router = yield* routerOf({ line: marked, reply });
		const { ctx, shown } = contextOf(false);

		yield* Effect.provideService(statusShown(routerPort)(ctx), Router, router.service);

		const asked = yield* Ref.get(router.asked);

		assert.deepStrictEqual({ asked, shown }, { asked: [], shown: [] });
	}),
);

const noRouter = "phi-router status --port 47498: no router answers there. A protected session starts the router.";

it.effect("when no router answers, the status bar says why, and /phi shows it as an error", () =>
	Effect.gen(function* down() {
		const router = yield* routerOf({ reply: noRouter });
		const { ctx, shown } = contextOf(true);

		const both = Effect.all([statusShown(routerPort)(ctx), answered(routerPort)("", ctx)], {
			concurrency: 1,
			discard: true,
		});

		yield* Effect.provideService(both, Router, router.service);

		assert.deepStrictEqual(shown, [
			["status", noRouter],
			["error", noRouter],
		]);
	}),
);

it.effect("when the CLI fails, the status bar and /phi name the command and its first line", () =>
	Effect.gen(function* failing() {
		const router = yield* routerOf("fails");
		const { ctx, shown } = contextOf(true);

		const both = Effect.all([statusShown(routerPort)(ctx), answered(routerPort)("", ctx)], {
			concurrency: 1,
			discard: true,
		});

		yield* Effect.provideService(both, Router, router.service);

		assert.deepStrictEqual(shown, [
			["status", `phi-router statusline failed: ${unanswered}`],
			["error", `phi-router statusline failed: ${unanswered}`],
		]);
	}),
);

it.effect(
	"/phi pin, like any word /phi does not know, shows the usage, which names phi/sealed, and asks the router nothing",
	() =>
		Effect.gen(function* unknown() {
			const router = yield* routerOf({ line: marked, reply });
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
			const router = yield* routerOf({ line: marked, reply });
			const { ctx, shown } = contextOf(true, "anthropic");
			const phi = answered(routerPort);

			const all = Effect.all([phi("pin", ctx), phi("", ctx), statusShown(routerPort)(ctx)], {
				concurrency: 1,
				discard: true,
			});

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
					],
				},
			);
		}),
);
