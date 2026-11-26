import { DateTime, Effect, Struct } from "effect";
import { assert, it } from "@effect/vitest";
import { overflowNotice, sealNotice, statusLine, statusText } from "./phi-text.ts";
import type { Reported } from "./phi-text.ts";

const back = "2026-05-28T14:30:00.000Z";

const utc = DateTime.zoneMakeNamedUnsafe("UTC");

const requests = { many: 6, one: 1 } as const;

const subscriptions = { one: 1, two: 2 } as const;

const statusOf = (substitute: boolean): Reported => ({
	accounts: {
		clean: [
			{ name: "open", vendor: "anthropic" },
			{ name: "open-2", rateLimitedUntil: back, vendor: "anthropic" },
		],
		sealed: [{ name: "baa", vendor: "anthropic" }],
	},
	cleared: 2,
	last: { account: "baa", model: "claude-sealed", substitute },
	sealed: 1,
	session: "s-1",
});

it.effect(
	"/phi and the seal notice name the last request's model, say it was a substitute only when it was, and /phi shows when a stamped open account is back",
	() =>
		Effect.gen(function* shown() {
			const texts = yield* Effect.forEach(
				[false, true],
				(substitute) =>
					Effect.map(statusText(statusOf(substitute)), (status) => ({
						notice: sealNotice({ count: 1, status: statusOf(substitute) }),
						status,
					})),
				{ concurrency: 1 },
			);

			assert.deepStrictEqual(texts, [
				{
					notice:
						"phi-router: 1 message held patient identifiers. The open account sees a handle in place of each. Last request: baa, model claude-sealed.",
					status:
						"phi-router, session s-1\nLast request: baa, model claude-sealed\nMessages: 1 sealed, 2 cleared\nClean lane: open, open-2 (rate-limited until 14:30)\nSealed lane: baa",
				},
				{
					notice:
						"phi-router: 1 message held patient identifiers. The open account sees a handle in place of each. Last request: baa, model claude-sealed, a substitute for the requested model.",
					status:
						"phi-router, session s-1\nLast request: baa, model claude-sealed, a substitute for the requested model\nMessages: 1 sealed, 2 cleared\nClean lane: open, open-2 (rate-limited until 14:30)\nSealed lane: baa",
				},
			]);
		}).pipe(Effect.provideService(DateTime.CurrentTimeZone, utc)),
);

it.effect("the overflow notice says why the requests ran on the BAA account and how to add a subscription", () =>
	Effect.gen(function* told() {
		const backAt = DateTime.toEpochMillis(DateTime.makeUnsafe(back));

		const notices = yield* Effect.forEach(
			[
				{ back: backAt, count: requests.many, subscriptions: subscriptions.one },
				{ back: backAt, count: requests.one, subscriptions: subscriptions.two },
				{ count: requests.one, subscriptions: subscriptions.one },
			],
			overflowNotice,
			{ concurrency: 1 },
		);

		assert.deepStrictEqual(notices, [
			"phi-router: your subscription is rate-limited until 14:30, so 6 requests ran on your BAA account. Add another subscription: npx phi-router accounts add",
			"phi-router: your subscriptions are rate-limited until 14:30, so 1 request ran on your BAA account. Add another subscription: npx phi-router accounts add",
			"phi-router: your subscription did not answer, so 1 request ran on your BAA account. Add another subscription: npx phi-router accounts add",
		]);
	}).pipe(Effect.provideService(DateTime.CurrentTimeZone, utc)),
);

it.effect(
	"the status line shows pi's status bar entry, and the pinned subagent's runs once the status counts them",
	() =>
		Effect.sync(() => {
			const status = statusOf(false);

			assert.deepStrictEqual(
				[
					statusLine(status),
					statusLine(Struct.assign(status, { pinned: { runs: 1 } })),
					statusLine(Struct.assign(status, { pinned: { runs: 3 } })),
				],
				[
					"phi · baa, model claude-sealed · 1 sealed · 2 cleared",
					"phi · baa, model claude-sealed · 1 sealed · 2 cleared · 1 pinned run",
					"phi · baa, model claude-sealed · 1 sealed · 2 cleared · 3 pinned runs",
				],
			);
		}),
);
