import { Array, DateTime, Effect, Ref } from "effect";
import type { Observe, ShownContext } from "./phi.ts";
import { assert, it } from "@effect/vitest";
import { compactionSent, promptSent, sessionLeased } from "./proof.ts";
import { CommandFailed } from "#shared/cli.ts";
import type { HeldRequestContext } from "./proof.ts";
import { Router } from "#pi/client/router.ts";

const routerPort = 47_496;

const utc = DateTime.zoneMakeNamedUnsafe("UTC");

const refusal = "phi-router: no BAA key is saved for anthropic. Run phi-router setup.";

const leaseLine = `start pi-session-1 /work ${String(routerPort)}`;

const routerOf = Effect.fnUntraced(function* routerOf(refuses: boolean) {
	const asked = yield* Ref.make<readonly string[]>([]);

	const refused = Effect.fail(
		CommandFailed.make({ cause: `${refusal}\n    at start (cli.js:1:1)\n`, command: "start" }),
	);

	const recorded = (line: string): Effect.Effect<void> => Ref.update(asked, Array.append(line));

	const service = Router.of({
		models: Effect.succeed({}),
		setUp: () => Effect.die("the proof sets nothing up"),
		setupStep: () => Effect.die("the proof sets nothing up"),
		start: (session, folder, port) =>
			Effect.andThen(
				recorded(`start ${session} ${folder} ${String(port)}`),
				Effect.when(refused, Effect.succeed(refuses)),
			),
		status: () => Effect.die("the proof asks no status"),
	});

	return { asked, service };
});

type SessionContext = HeldRequestContext & ShownContext;

interface Shows {
	readonly ctx: SessionContext;
	readonly shown: readonly string[];
}

const contextOf = (provider: string): Shows => {
	const shown: string[] = [];

	const ctx: SessionContext = {
		cwd: "/work",
		hasUI: true,
		model: { provider },
		sessionManager: { getSessionId: (): string => "pi-session-1" },
		ui: {
			notify: (message, kind = "info"): void => {
				shown.push(`${kind}: ${message}`);
			},
			setStatus: (_key, text = ""): void => {
				shown.push(`status: ${text}`);
			},
		},
	};

	return { ctx, shown };
};

const sent = Effect.fnUntraced(function* sent(refuses: boolean, provider: string) {
	const router = yield* routerOf(refuses);
	const { ctx, shown } = contextOf(provider);
	const both = Effect.all([promptSent(routerPort)(ctx), compactionSent(routerPort)(ctx)], { concurrency: 1 });
	const answers = yield* Effect.provideService(both, Router, router.service);
	const asked = yield* Ref.get(router.asked);

	return { answers, asked, shown };
});

it.effect("lets a prompt and a compaction of another provider go without asking the router", () =>
	Effect.gen(function* otherProvider() {
		const outcome = yield* sent(true, "anthropic");

		assert.deepStrictEqual(outcome, { answers: [{ action: "continue" }, { cancel: false }], asked: [], shown: [] });
	}),
);

it.effect("sends a phi prompt and compaction once the router leaves the lease for the session", () =>
	Effect.gen(function* leased() {
		const outcome = yield* sent(false, "phi");

		assert.deepStrictEqual(outcome, {
			answers: [{ action: "continue" }, { cancel: false }],
			asked: [leaseLine, leaseLine],
			shown: [],
		});
	}),
);

it.effect("holds back a phi prompt and compaction the router refuses, and shows the line start printed", () =>
	Effect.gen(function* refused() {
		const outcome = yield* sent(true, "phi");

		assert.deepStrictEqual(outcome, {
			answers: [{ action: "handled" }, { cancel: true }],
			asked: [leaseLine, leaseLine],
			shown: [`error: ${refusal}`, `error: ${refusal}`],
		});
	}),
);

const showLeased: Observe = (ctx) =>
	Effect.sync(() => {
		ctx.ui.setStatus("phi", "leased");
	});

it.effect("a session the router refuses at start shows nothing, and one it leases shows its status", () =>
	Effect.gen(function* atStart() {
		const refusing = yield* routerOf(true);
		const leasing = yield* routerOf(false);
		const { ctx, shown } = contextOf("phi");
		const started = sessionLeased(routerPort)(showLeased, ctx);

		yield* Effect.provideService(started, Router, refusing.service).pipe(
			Effect.provideService(DateTime.CurrentTimeZone, utc),
		);
		yield* Effect.provideService(started, Router, leasing.service).pipe(
			Effect.provideService(DateTime.CurrentTimeZone, utc),
		);

		assert.deepStrictEqual(shown, ["status: leased"]);
	}),
);
