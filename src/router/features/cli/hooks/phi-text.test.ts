import { Array, DateTime, Effect, String as Str, Struct } from "effect";
import { assert, it } from "@effect/vitest";
import { overflowNotice, sealNotice, statusLine, statusText, withheldNotice } from "./phi-text.ts";
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
						"session s-1\nLast request: baa, model claude-sealed\nMessages: 1 sealed, 2 cleared\nClean lane: open, open-2 (rate-limited, tried again at 14:30)\nSealed lane: baa",
				},
				{
					notice:
						"phi-router: 1 message held patient identifiers. The open account sees a handle in place of each. Last request: baa, model claude-sealed, a substitute for the requested model.",
					status:
						"session s-1\nLast request: baa, model claude-sealed, a substitute for the requested model\nMessages: 1 sealed, 2 cleared\nClean lane: open, open-2 (rate-limited, tried again at 14:30)\nSealed lane: baa",
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
			"phi-router: your subscription hit its rate limit, so 6 requests ran on your BAA account. phi-router tries it again at 14:30. Add another subscription: npx phi-router accounts add",
			"phi-router: your subscriptions hit their rate limits, so 1 request ran on your BAA account. phi-router tries them again at 14:30. Add another subscription: npx phi-router accounts add",
			"phi-router: 1 request ran on your BAA account because your subscription hit a rate limit or did not answer. Add another subscription: npx phi-router accounts add",
		]);
	}).pipe(Effect.provideService(DateTime.CurrentTimeZone, utc)),
);

it.effect("the status line names the last request's account, and the pinned subagent's runs once there is one", () =>
	Effect.gen(function* lines() {
		const status = statusOf(false);

		const shown = yield* Effect.forEach(
			[
				status,
				Struct.assign(status, { pinned: { cleared: [], gaveUp: 0, rewrites: 0, runs: 0, withheld: [] } }),
				Struct.assign(status, { pinned: { cleared: [], gaveUp: 0, rewrites: 0, runs: 1, withheld: [] } }),
				Struct.assign(status, { pinned: { cleared: [], gaveUp: 0, rewrites: 2, runs: 3, withheld: [] } }),
			],
			(each) => statusLine(each),
			{ concurrency: 1 },
		);

		assert.deepStrictEqual(shown, [
			"phi · baa · 1 sealed · 2 cleared",
			"phi · baa · 1 sealed · 2 cleared",
			"phi · baa · 1 sealed · 2 cleared · 1 pinned run",
			"phi · baa · 1 sealed · 2 cleared · 3 pinned runs",
		]);
	}).pipe(Effect.provideService(DateTime.CurrentTimeZone, utc)),
);

const ranLast = { account: "claude-2", model: "claude-opus", overflow: true, substitute: false };

const noticed: Reported = {
	accounts: {
		clean: [{ name: "claude-1", rateLimitedUntil: back, vendor: "anthropic" }],
		sealed: [{ name: "claude-2", vendor: "anthropic" }],
	},
	cleared: 15,
	last: ranLast,
	overflowed: 36,
	pinned: { cleared: [], gaveUp: 1, rewrites: 5, runs: 1, withheld: [] },
	sealed: 0,
	session: "s-1",
};

const waiting = { installed: "0.6.0", running: "0.5.1" };

const columns = 80;

const keycaps = 40;

const keycapRan = Struct.assign(ranLast, { account: Str.repeat(keycaps)("#️⃣") });

it.effect(
	"the status line marks the overflow while the last request overflowed, till the stamp's HH:MM when one exists, and no longer, the withheld answers and the version wait in 80 columns whatever the account's name and the version, and /phi says each in full",
	() =>
		Effect.gen(function* marked() {
			const line = yield* statusLine(noticed, waiting);
			const text = yield* statusText(noticed, waiting);
			const reply = Str.split(text, "\n");
			const roomy = yield* statusLine(Struct.assign(noticed, { overflowed: 0 }));

			const longNamed = yield* statusLine(
				Struct.assign(noticed, {
					last: Struct.assign(ranLast, { account: "claude-baa-login-of-the-clinic-team" }),
				}),
				waiting,
			);

			const longVersion = yield* statusLine(
				Struct.assign(noticed, {
					last: Struct.assign(ranLast, { account: "claude-baa-login-of-the-clinic-team" }),
				}),
				Struct.assign(waiting, { installed: "0.6.0-rc.20261126.1234567890" }),
			);

			const wideNamed = yield* statusLine(
				Struct.assign(noticed, {
					last: Struct.assign(ranLast, { account: "東京診療所の研究開発部門向けAnthropic企業契約アカウント" }),
				}),
				waiting,
			);

			const emojiNamed = yield* statusLine(
				Struct.assign(noticed, {
					last: Struct.assign(ranLast, { account: "🚀 anthropic-enterprise-subscription-team" }),
				}),
				waiting,
			);

			const keycapNamed = yield* statusLine(Struct.assign(noticed, { last: keycapRan }), waiting);

			const unstamped = Struct.assign(noticed.accounts, {
				clean: [{ name: "claude-1", vendor: "anthropic" as const }],
			});

			const backAgain = yield* statusLine(
				Struct.assign(noticed, {
					accounts: unstamped,
					last: Struct.assign(ranLast, { account: "claude-1", overflow: false }),
				}),
			);

			const servedElsewhere = yield* statusLine(
				Struct.assign(noticed, {
					accounts: Struct.assign(noticed.accounts, {
						clean: [...noticed.accounts.clean, { name: "claude-3", vendor: "anthropic" as const }],
					}),
					last: Struct.assign(ranLast, { account: "claude-3", overflow: false }),
				}),
			);

			const unanswered = yield* statusLine(
				Struct.assign(noticed, {
					accounts: unstamped,
					last: Struct.assign(ranLast, { overflow: true }),
				}),
			);

			assert.deepStrictEqual(
				{
					backAgain,
					emojiNamed,
					fits: Array.map([line, longNamed, longVersion], ({ length }) => length <= columns),
					keycapNamed,
					line,
					longNamed,
					longVersion,
					reply,
					roomy,
					servedElsewhere,
					unanswered,
					wideNamed,
				},
				{
					backAgain: "phi · claude-1 · 0 sealed · 15 cleared · 1 pinned run · 1 withheld",
					emojiNamed: "phi · 🚀 anthropi… · 0 sealed · 1 withheld · overflow till 14:30 · 0.6.0 pending",
					fits: [true, true, true],
					keycapNamed: "phi · #️⃣#️⃣#️⃣#️⃣#️⃣#… · 0 sealed · 1 withheld · overflow till 14:30 · 0.6.0 pending",
					line: "phi · claude-2 · 0 sealed · 1 withheld · overflow till 14:30 · 0.6.0 pending",
					longNamed: "phi · claude-baa-… · 0 sealed · 1 withheld · overflow till 14:30 · 0.6.0 pending",
					longVersion: "phi · … · 0 sealed · 1 withheld · overflow till 14:30 · 0.6.0-rc.20261126.12345…",
					reply: [
						"session s-1",
						"Last request: claude-2, model claude-opus",
						"Messages: 0 sealed, 15 cleared",
						"Pinned subagent: 1 run, 5 rewrites, 1 answer withheld",
						"Clean lane: claude-1 (rate-limited, tried again at 14:30)",
						"Sealed lane: claude-2",
						"Overflow: your subscription hit its rate limit, so 36 requests ran on your BAA account. phi-router tries it again at 14:30. Add another subscription: npx phi-router accounts add",
						"phi-router 0.6.0 is installed. Your open windows still run 0.5.1 until you close them all.",
					],
					roomy: "phi · claude-2 · 0 sealed · 15 cleared · 1 pinned run · 1 withheld",
					servedElsewhere: "phi · claude-3 · 0 sealed · 15 cleared · 1 pinned run · 1 withheld",
					unanswered: "phi · claude-2 · 0 sealed · 15 cleared · 1 pinned run · 1 withheld · overflow",
					wideNamed: "phi · 東京診療所… · 0 sealed · 1 withheld · overflow till 14:30 · 0.6.0 pending",
				},
			);
		}).pipe(Effect.provideService(DateTime.CurrentTimeZone, utc)),
);

it.effect(
	"the withheld notice counts the pinned subagent answers phi-router withheld and says the agent got handles",
	() =>
		Effect.sync(() => {
			assert.deepStrictEqual(
				[withheldNotice(requests.one), withheldNotice(requests.many)],
				[
					"phi-router: 1 pinned subagent answer still held patient identifiers after 5 rewrites, so phi-router withheld it, and the agent got its handle instead.",
					"phi-router: 6 pinned subagent answers still held patient identifiers after 5 rewrites, so phi-router withheld them, and the agent got their handles instead.",
				],
			);
		}),
);

it.effect(
	"/phi shows the session's pinned subagent runs, rewrites and withheld answers beside the message counts",
	() =>
		Effect.gen(function* pinnedShown() {
			const status = yield* statusText(
				Struct.assign(statusOf(false), { pinned: { cleared: [], gaveUp: 1, rewrites: 6, runs: 2, withheld: [] } }),
			);

			assert.include(
				status,
				"Messages: 1 sealed, 2 cleared\nPinned subagent: 2 runs, 6 rewrites, 1 answer withheld\nClean lane: ",
			);
		}).pipe(Effect.provideService(DateTime.CurrentTimeZone, utc)),
);
