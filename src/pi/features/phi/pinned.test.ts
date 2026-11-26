import type { AnswerCheck, AnswerChecked } from "#shared/cli.ts";
import { Array, ConfigProvider, Effect, Option, Ref, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CommandFailed } from "#shared/cli.ts";
import { Router } from "#pi/client/router.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { answerChecked } from "#pi/features/phi/pinned.ts";

const routerPort = 47_498;

const rootSession = "root-session-1";

const sealedAnswer = "Jane Roe's claim failed on 2026-05-01.";

const free = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 };

const said = (text: string): AssistantMessage => ({
	api: "anthropic-messages",
	content: [{ text, type: "text" }],
	model: "claude-baa",
	provider: "phi",
	role: "assistant",
	stopReason: "stop",
	timestamp: 0,
	usage: { cacheRead: 0, cacheWrite: 0, cost: free, input: 0, output: 0, totalTokens: 0 },
});

type Asked = typeof AnswerCheck.Type & { readonly port: number };

interface Given {
	readonly checked: typeof AnswerChecked.Type | "unanswered";
	readonly env: Readonly<Record<string, string>>;
	readonly model?: { readonly provider: string; readonly id: string };
	readonly continues?: boolean;
}

const checkedOf = (checked: Given["checked"]): Effect.Effect<typeof AnswerChecked.Type, CommandFailed> => {
	if (checked === "unanswered") {
		return Effect.fail(CommandFailed.make({ cause: "unanswered", command: "answer-check-json" }));
	}

	return Effect.succeed(checked);
};

const settled = Effect.fnUntraced(function* settled(given: Given) {
	const asked = yield* Ref.make<readonly Asked[]>([]);
	const delegate = SessionManager.inMemory();

	delegate.appendMessage(said("Reading the claims file."));

	const answerEntry = delegate.appendMessage(said(sealedAnswer));

	const router = Router.of({
		answerCheck: ({ answer, session, subagent }, port) =>
			Effect.andThen(Ref.update(asked, Array.append({ answer, port, session, subagent })), checkedOf(given.checked)),
		models: Effect.succeed({}),
		setUp: () => Effect.die("the answer check sets nothing up"),
		setupStep: () => Effect.die("the answer check sets nothing up"),
		start: () => Effect.die("the answer check starts nothing"),
		status: () => Effect.die("the answer check asks no status"),
	});

	const ctx = {
		model: given.model ?? { id: "sealed", provider: "phi" },
		sessionManager: delegate,
	};

	const event = { continue: given.continues ?? false, outcome: "completed" as const };

	const settlement = yield* answerChecked(routerPort)(event, ctx).pipe(
		Effect.provideService(Router, router),
		Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(given.env)),
	);

	return { answerEntry, asked: yield* Ref.get(asked), delegate: delegate.getSessionId(), settlement };
});

const delegated = { PHI_ROUTER_SESSION: rootSession };

const rewrite = "phi-router withheld your last answer: it holds a full name. This is rewrite attempt 1 of 5.";

const rewriting = { attempt: 1, limit: 5, message: rewrite, outcome: "rewrite" } as const;

it.effect(
	"a pinned delegate's last answer goes to the answer check under its root agent's session, and a rewrite continues it with the message",
	() =>
		Effect.gen(function* rewritten() {
			const { asked, delegate, settlement } = yield* settled({ checked: rewriting, env: delegated });

			assert.deepStrictEqual(
				{ asked, settlement },
				{
					asked: [{ answer: sealedAnswer, port: routerPort, session: rootSession, subagent: delegate }],
					settlement: Option.some({
						continues: true,
						entry: { content: rewrite, customType: "phi-router-rewrite", display: true, type: "custom_message" },
					}),
				},
			);
		}),
);

it.effect("after the last rewrite the answer's entry reads as the router's reply, so the parent never reads it", () =>
	Effect.gen(function* gaveUp() {
		const reply = "[sealed h4] The pinned subagent's answer still held patient identifiers.";

		const { answerEntry, settlement } = yield* settled({
			checked: { handle: "h4", outcome: "gave-up", reply },
			env: delegated,
		});

		assert.deepStrictEqual(
			settlement,
			Option.some({
				continues: false,
				entry: { replacement: { content: reply }, targetId: answerEntry, type: "context_edit" },
			}),
		);
	}),
);

it.effect("an answer the router could not check is withheld, with why in its place", () =>
	Effect.gen(function* unchecked() {
		const { answerEntry, settlement } = yield* settled({
			checked: "unanswered",
			env: delegated,
		});

		const content =
			"phi-router could not check the pinned subagent's answer, so it withheld it: phi-router answer-check-json failed: unanswered";

		assert.deepStrictEqual(
			settlement,
			Option.some({
				continues: false,
				entry: { replacement: { content }, targetId: answerEntry, type: "context_edit" },
			}),
		);
	}),
);

it.effect("a cleared answer settles as pi has it", () =>
	Effect.gen(function* clearedAnswer() {
		const { asked, settlement } = yield* settled({ checked: { outcome: "cleared" }, env: delegated });

		assert.deepStrictEqual({ asked: asked.length, settlement }, { asked: 1, settlement: Option.none() });
	}),
);

it.effect(
	"a root agent on phi/sealed, a delegate on another model and a run that continues anyway ask the router nothing",
	() =>
		Effect.gen(function* unchecked() {
			const runs = yield* Effect.all(
				[
					settled({ checked: rewriting, env: {} }),
					settled({ checked: rewriting, env: delegated, model: { id: "auto", provider: "phi" } }),
					settled({ checked: rewriting, continues: true, env: delegated }),
				],
				{ concurrency: 1 },
			);

			assert.deepStrictEqual(
				pipe(
					runs,
					Array.map(({ asked, settlement }) => ({ asked: asked.length, settlement })),
				),
				[
					{ asked: 0, settlement: Option.none() },
					{ asked: 0, settlement: Option.none() },
					{ asked: 0, settlement: Option.none() },
				],
			);
		}),
);
