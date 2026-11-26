import type { AnswerCheck, AnswerChecked, Pinned, Status } from "#shared/cli.ts";
import { Array, Effect, Exit, Option, Ref, Schema, Struct, pipe } from "effect";
import { RewriteAsked, answered } from "./answer-check.ts";
import { SessionId, productPort } from "#shared/cli.ts";
import { assert, it } from "@effect/vitest";
import { ClaudeSubagents } from "#router/client/harnesses/index.ts";
import { Digest } from "effect/crypto";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { answerKey } from "#router/features/answer-check/index.ts";

const Printed = Schema.fromJsonString(Schema.Json);

const session = "8a256f3e-74cb-4ebb-8362-80d3bb4668eb";

const agent = "a71a9af7ad3b0ddc1";

const pinned = "phi-router:phi-sealed";

const answer = "The member's SSN is 078-05-1120. Their internal id is p-17.";

const subagentStop = (agentType: string, mode: string): string =>
	`{"session_id":"${session}","transcript_path":"/work/.claude/projects/-work/${session}.jsonl","cwd":"/work","prompt_id":"61cee232-150a-4d21-ac58-04dfcc556f4f","permission_mode":"${mode}","agent_id":"${agent}","agent_type":"${agentType}","effort":{"level":"high"},"hook_event_name":"SubagentStop","stop_hook_active":false,"agent_transcript_path":"/work/.claude/projects/-work/${session}/subagents/agent-${agent}.jsonl","last_assistant_message":"${answer}","background_tasks":[],"session_crons":[]}`;

const handback = (agentType: string): string =>
	`{"session_id":"${session}","transcript_path":"/work/.claude/projects/-work/${session}.jsonl","cwd":"/work","permission_mode":"auto","agent_id":"${agent}","agent_type":"${agentType}","hook_event_name":"PreToolUse","tool_name":"SubagentHandback","tool_input":{"message":"${answer}","status":"completed"},"tool_use_id":"toolu_handback"}`;

const agentResponse = {
	agentId: agent,
	agentType: pinned,
	canContinueAgent: true,
	resolvedModel: "phi/sealed",
	status: "completed",
	totalToolUseCount: 1,
};

const agentResult = (subagentType: string): string =>
	`{"session_id":"${session}","cwd":"/work","permission_mode":"default","hook_event_name":"PostToolUse","tool_name":"Agent","tool_input":{"description":"Look up the member","prompt":"Find the member's internal id. The member is in h1.","subagent_type":"${subagentType}","run_in_background":false},"tool_response":{"status":"completed","agentId":"${agent}","agentType":"${pinned}","content":[{"type":"text","text":"<tools-used-before-summary>Read</tools-used-before-summary>\\n"},{"type":"text","text":"  ${answer}\\n"}],"harnessNoteCount":1,"harnessTailCount":0,"resolvedModel":"phi/sealed","totalToolUseCount":1,"canContinueAgent":true},"tool_use_id":"toolu_agent","duration_ms":53}`;

const agentLaunched = `{"session_id":"${session}","cwd":"/work","permission_mode":"default","hook_event_name":"PostToolUse","tool_name":"Agent","tool_input":{"description":"Look up the member","prompt":"Find the member's internal id. The member is in h1.","subagent_type":"${pinned}","run_in_background":true},"tool_response":{"isAsync":true,"status":"async_launched","agentId":"${agent}","outputFile":"/tmp/claude/tasks/${agent}.output"},"tool_use_id":"toolu_agent","duration_ms":53}`;

const notified = (prompt: string): string =>
	`{"session_id":"${session}","transcript_path":"/work/.claude/projects/-work/${session}.jsonl","cwd":"/work","prompt_id":"0d4c3a8e-1c37-4c35-9b1e-6a1c0c7b57a1","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt":"${prompt}"}`;

const notification = (task: string, result: string): string =>
	`<task-notification>\\n<task-id>${task}</task-id>\\n<tool-use-id>toolu_agent</tool-use-id>\\n<output-file>/tmp/claude/tasks/${task}.output</output-file>\\n<status>completed</status>\\n<summary>Agent \\"Look up the member\\" finished</summary>\\n${result}<usage><subagent_tokens>20</subagent_tokens><tool_uses>1</tool_uses><duration_ms>155</duration_ms></usage>\\n</task-notification>`;

const escapedAnswer = "The member &lt;b&gt;p-17&lt;/b&gt; has 3 claims &amp;amp; 1 denial.";

const rewrite: typeof AnswerChecked.Type = {
	attempt: 1,
	limit: 5,
	message: 'phi-router withheld your last answer: it holds a Social Security number (ssn): "078-05-1120".',
	outcome: "rewrite",
};

const reply =
	"[sealed h4] The pinned subagent's answer still held patient identifiers after 5 rewrites, so phi-router could not clear it and withheld it. h4 is its handle.";

const gaveUp: typeof AnswerChecked.Type = { handle: "h4", outcome: "gave-up", reply };

const cleared: typeof AnswerChecked.Type = { outcome: "cleared" };

type Answers = Pick<typeof Pinned.Type, "cleared" | "withheld">;

const noAnswers: Answers = { cleared: [], withheld: [] };

const statusWith = (answers: Answers): typeof Status.Type => ({
	accounts: { clean: [], sealed: [] },
	cleared: 0,
	last: { account: "baa", model: "claude-sealed", substitute: false },
	pinned: Struct.assign(answers, { gaveUp: answers.withheld.length, rewrites: 5, runs: 1 }),
	sealed: 0,
	session: SessionId.make(session),
});

const checkOfAnswer = { answer, session, subagent: agent };

type Asked = typeof AnswerCheck.Type | "status";

const hookRun = Effect.fnUntraced(function* hookRun(
	stdin: string,
	router: {
		readonly outcome: typeof AnswerChecked.Type;
		readonly answers?: Answers | "unanswered" | "no answer check";
	},
) {
	const asked = yield* Ref.make<readonly Asked[]>([]);
	const record = (one: Asked): Effect.Effect<void> => Ref.update(asked, Array.append(one));

	const requests = SessionRequests.of({
		answerCheck: (_port, check) => Effect.as(record(check), router.outcome),
		status: () => {
			const answers = router.answers ?? noAnswers;

			if (answers === "unanswered") {
				return Effect.andThen(record("status"), Effect.fail({ reason: "no router answers there" as const }));
			}

			if (answers === "no answer check") {
				return Effect.as(record("status"), Struct.omit(statusWith(noAnswers), ["pinned"]));
			}

			return Effect.as(record("status"), statusWith(answers));
		},
	});

	const subagents = ClaudeSubagents.of({
		typeOf: ({ subagent }) =>
			Effect.succeedSome(
				Option.getOrElse(
					Option.liftPredicate(pinned, () => subagent === agent),
					() => "general-purpose",
				),
			),
	});

	const exit = yield* Effect.exit(
		answered(productPort, stdin).pipe(
			Effect.provideService(SessionRequests, requests),
			Effect.provideService(ClaudeSubagents, subagents),
		),
	);

	const rewriteAsked = Option.map(
		Option.filter(Exit.findErrorOption(exit), Schema.is(RewriteAsked)),
		({ reason }) => reason,
	);

	const shown = yield* Effect.transposeOption(
		Option.map(Exit.getSuccess(exit).pipe(Option.flatten), Schema.decodeEffect(Printed)),
	);

	return { asked: yield* Ref.get(asked), rewriteAsked, shown };
});

const none = { rewriteAsked: Option.none<string>(), shown: Option.none<Schema.Json>() };

const ran = (asked: readonly Asked[]): Ran => Struct.assign(none, { asked });

interface Ran {
	readonly asked: readonly Asked[];
	readonly rewriteAsked: Option.Option<string>;
	readonly shown: Option.Option<Schema.Json>;
}

it.layer(Digest.layerWebCrypto)("the answer-check hook", (test) => {
	test.effect(
		"SubagentStop checks the pinned subagent's last answer once, asks for a rewrite with the router's message, and lets a cleared or withheld answer stop",
		() =>
			Effect.gen(function* stops() {
				const stop = subagentStop(pinned, "default");

				const runs = yield* Effect.forEach([rewrite, cleared, gaveUp], (outcome) => hookRun(stop, { outcome }), {
					concurrency: 1,
				});

				assert.deepStrictEqual(runs, [
					Struct.assign(ran([checkOfAnswer]), { rewriteAsked: Option.some(rewrite.message) }),
					ran([checkOfAnswer]),
					ran([checkOfAnswer]),
				]);
			}),
	);

	test.effect(
		"SubagentStop checks nothing for another subagent, a session's internal agent, or a pinned subagent in auto mode, which hands back through SubagentHandback",
		() =>
			Effect.gen(function* skipped() {
				const stops = [
					subagentStop("Explore", "default"),
					subagentStop("", "default"),
					subagentStop(pinned, "auto"),
				];

				const runs = yield* Effect.forEach(stops, (stdin) => hookRun(stdin, { outcome: rewrite }), {
					concurrency: 1,
				});

				assert.deepStrictEqual(
					runs,
					pipe(
						stops,
						Array.map(() => ran([])),
					),
				);
			}),
	);

	test.effect(
		"SubagentHandback is denied with the rewrite message, handed back with the reply in place of a withheld answer, and passed when cleared",
		() =>
			Effect.gen(function* handedBack() {
				const runs = yield* Effect.forEach(
					[
						[pinned, rewrite],
						[pinned, gaveUp],
						[pinned, cleared],
						["Explore", rewrite],
					] as const,
					([agentType, outcome]) => hookRun(handback(agentType), { outcome }),
					{ concurrency: 1 },
				);

				assert.deepStrictEqual(runs, [
					Struct.assign(ran([checkOfAnswer]), {
						shown: Option.some<Schema.Json>({
							hookSpecificOutput: {
								hookEventName: "PreToolUse",
								permissionDecision: "deny",
								permissionDecisionReason: rewrite.message,
							},
						}),
					}),
					Struct.assign(ran([checkOfAnswer]), {
						shown: Option.some<Schema.Json>({
							hookSpecificOutput: {
								hookEventName: "PreToolUse",
								permissionDecision: "allow",
								updatedInput: { message: reply, status: "completed" },
							},
						}),
					}),
					ran([checkOfAnswer]),
					ran([]),
				]);
			}),
	);

	test.effect(
		"the pinned subagent's Agent result reaches the root agent unchanged only when the router cleared that answer, as the reply when the router withheld it, and as the could-not-check line otherwise",
		() =>
			Effect.gen(function* delivered() {
				const key = yield* answerKey(answer);
				const clearedIt = Struct.assign(noAnswers, { cleared: [{ key, subagent: agent }] });
				const clearedAnother = Struct.assign(noAnswers, { cleared: [{ key: "another", subagent: agent }] });
				const withheldIt = Struct.assign(clearedIt, { withheld: [{ reply, subagent: agent }] });

				const runs = yield* Effect.forEach(
					[
						[agentResult(pinned), clearedIt],
						[agentResult(pinned), withheldIt],
						[agentResult(pinned), clearedAnother],
						[agentResult(pinned), "unanswered"],
						[agentResult(pinned), "no answer check"],
						[agentResult("Explore"), noAnswers],
						[agentLaunched, noAnswers],
					] as const,
					([stdin, answers]) => hookRun(stdin, { answers, outcome: cleared }),
					{ concurrency: 1 },
				);

				const replacedBy = (text: string): Ran =>
					Struct.assign(ran(["status"]), {
						shown: Option.some<Schema.Json>({
							hookSpecificOutput: {
								hookEventName: "PostToolUse",
								updatedToolOutput: Struct.assign(agentResponse, {
									content: [{ text, type: "text" }],
									harnessNoteCount: 0,
									harnessTailCount: 0,
								}),
							},
						}),
					});

				const unchecked = "phi-router could not check the pinned subagent's answer, so it withheld it: ";

				assert.deepStrictEqual(runs, [
					ran(["status"]),
					replacedBy(reply),
					replacedBy(`${unchecked}phi-router has no record that it cleared this answer.`),
					replacedBy(
						`${unchecked}phi-router status --port ${String(productPort)}: no router answers there. A protected session starts the router.`,
					),
					replacedBy(`${unchecked}phi-router has no record that it cleared this answer.`),
					ran([]),
					ran([]),
				]);
			}),
	);

	test.effect(
		"a pinned subagent's task notification reaches the root agent only when the router cleared its answer, and is blocked with the reason otherwise; other notifications and prompts pass unread",
		() =>
			Effect.gen(function* notifications() {
				const key = yield* answerKey("The member <b>p-17</b> has 3 claims &amp; 1 denial.");
				const clearedIt = Struct.assign(noAnswers, { cleared: [{ key, subagent: agent }] });
				const withheldIt = Struct.assign(noAnswers, { withheld: [{ reply, subagent: agent }] });
				const pinnedNotice = notified(notification(agent, `<result>${escapedAnswer}</result>\\n`));

				const runs = yield* Effect.forEach(
					[
						[pinnedNotice, clearedIt],
						[pinnedNotice, withheldIt],
						[pinnedNotice, noAnswers],
						[notified(notification("a0000000000000000", `<result>${escapedAnswer}</result>\\n`)), noAnswers],
						[notified(notification("bxyuvieze", "")), noAnswers],
						[notified("Find the member's plan."), noAnswers],
					] as const,
					([stdin, answers]) => hookRun(stdin, { answers, outcome: cleared }),
					{ concurrency: 1 },
				);

				const blockedBy = (reason: string): Ran =>
					Struct.assign(ran(["status"]), {
						shown: Option.some<Schema.Json>({
							decision: "block",
							hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true },
							reason,
						}),
					});

				assert.deepStrictEqual(runs, [
					ran(["status"]),
					blockedBy(reply),
					blockedBy(
						"phi-router could not check the pinned subagent's answer, so it withheld it: phi-router has no record that it cleared this answer.",
					),
					ran([]),
					ran([]),
					ran([]),
				]);
			}),
	);
});
