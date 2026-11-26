import type { AgentBeforeSettleEvent, SessionBoundaryDraft, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AnswerChecked, CommandFailed } from "#shared/cli.ts";
import { Array, Effect, Match, Option, String as Str, pipe } from "effect";
import { failureText, rootSession } from "./phi.ts";
import { Router } from "#pi/client/router.ts";
import type { TextContent } from "@earendil-works/pi-ai";
import { piWire } from "#shared/pi.ts";

interface PinnedContext {
	readonly model: { readonly provider: string; readonly id: string } | undefined;
	readonly sessionManager: Pick<SessionManager, "getBranch" | "getSessionId">;
}

interface Answer {
	readonly entry: string;
	readonly text: string;
}

interface Settlement {
	readonly continues: boolean;
	readonly entry: SessionBoundaryDraft;
}

const rewriteType = "phi-router-rewrite";

const uncheckedReply = (failed: Pick<CommandFailed, "cause" | "command">): string =>
	`phi-router could not check the pinned subagent's answer, so it withheld it: ${failureText(failed)}`;

const pinned = (ctx: Pick<PinnedContext, "model">): boolean =>
	pipe(
		Option.fromNullishOr(ctx.model),
		Option.exists(({ id, provider }) => `${provider}/${id}` === piWire.models.sealed),
	);

const answerOf = (ctx: Pick<PinnedContext, "sessionManager">): Option.Option<Answer> =>
	pipe(
		ctx.sessionManager.getBranch(),
		Array.flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "assistant") {
				return [];
			}

			const said = pipe(
				entry.message.content,
				Array.filter((block): block is TextContent => block.type === "text"),
				Array.map((block) => block.text),
				Array.join(""),
			);

			return pipe(
				Option.liftPredicate(said, Str.isNonEmpty),
				Option.map((text) => ({ entry: entry.id, text })),
				Option.toArray,
			);
		}),
		Array.last,
	);

const replaced = (answer: Answer, reply: string): Settlement => ({
	continues: false,
	entry: { replacement: { content: reply }, targetId: answer.entry, type: "context_edit" },
});

const settlementOf = (answer: Answer): ((checked: typeof AnswerChecked.Type) => Option.Option<Settlement>) =>
	Match.type<typeof AnswerChecked.Type>().pipe(
		Match.discriminatorsExhaustive("outcome")({
			cleared: () => Option.none<Settlement>(),
			"gave-up": ({ reply }) => Option.some(replaced(answer, reply)),
			rewrite: ({ message }) =>
				Option.some<Settlement>({
					continues: true,
					entry: { content: message, customType: rewriteType, display: true, type: "custom_message" },
				}),
		}),
	);

const answerChecked =
	(port: number) =>
	(
		event: Readonly<Pick<AgentBeforeSettleEvent, "continue" | "outcome">>,
		ctx: PinnedContext,
	): Effect.Effect<Option.Option<Settlement>, never, Router> =>
		Effect.gen(function* checked() {
			const root = yield* rootSession;

			if (event.continue || event.outcome !== "completed" || !pinned(ctx)) {
				return Option.none();
			}

			const answer = answerOf(ctx);

			if (Option.isNone(root) || Option.isNone(answer)) {
				return Option.none();
			}

			const asked = { answer: answer.value.text, session: root.value, subagent: ctx.sessionManager.getSessionId() };

			return yield* Router.use((client) => client.answerCheck(asked, port)).pipe(
				Effect.map(settlementOf(answer.value)),
				Effect.catchTag("CommandFailed", (failed) =>
					Effect.succeedSome(replaced(answer.value, uncheckedReply(failed))),
				),
			);
		});

export { answerChecked };
