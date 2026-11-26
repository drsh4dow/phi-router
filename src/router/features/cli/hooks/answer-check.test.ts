import type { AnswerCheck, AnswerChecked, Status } from "#shared/cli.ts";
import { Array, Effect, Exit, Option, Ref, Schema, Struct, pipe } from "effect";
import { RewriteAsked, answered } from "./answer-check.ts";
import { SessionId, productPort } from "#shared/cli.ts";
import { assert, it } from "@effect/vitest";
import { SessionRequests } from "#router/client/router-port/index.ts";

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
	content: [{ text: answer, type: "text" }],
	resolvedModel: "phi/sealed",
	status: "completed",
	totalToolUseCount: 0,
};

const agentResult = (subagentType: string): string =>
	`{"session_id":"${session}","cwd":"/work","permission_mode":"default","hook_event_name":"PostToolUse","tool_name":"Agent","tool_input":{"description":"Look up the member","prompt":"Find the member's internal id. The member is in h1.","subagent_type":"${subagentType}","run_in_background":false},"tool_response":{"status":"completed","agentId":"${agent}","agentType":"${pinned}","content":[{"type":"text","text":"${answer}"}],"resolvedModel":"phi/sealed","totalToolUseCount":0,"canContinueAgent":true},"tool_use_id":"toolu_agent","duration_ms":53}`;

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

interface Withheld {
	readonly reply: string;
	readonly subagent: string;
}

const statusWith = (withheld: readonly Withheld[]): typeof Status.Type => ({
	accounts: { clean: [], sealed: [] },
	cleared: 0,
	last: { account: "baa", model: "claude-sealed", substitute: false },
	pinned: { gaveUp: withheld.length, rewrites: 5, runs: 1, withheld },
	sealed: 0,
	session: SessionId.make(session),
});

const checkOfAnswer = { answer, session, subagent: agent };

type Asked = typeof AnswerCheck.Type | "status";

const hookRun = Effect.fnUntraced(function* hookRun(
	stdin: string,
	router: { readonly outcome: typeof AnswerChecked.Type; readonly withheld?: readonly Withheld[] },
) {
	const asked = yield* Ref.make<readonly Asked[]>([]);
	const record = (one: Asked): Effect.Effect<void> => Ref.update(asked, Array.append(one));

	const requests = SessionRequests.of({
		answerCheck: (_port, check) => Effect.as(record(check), router.outcome),
		status: () => Effect.as(record("status"), statusWith(router.withheld ?? [])),
	});

	const exit = yield* Effect.exit(answered(productPort, stdin).pipe(Effect.provideService(SessionRequests, requests)));

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

const replacedResponse = Struct.assign(agentResponse, { content: [{ text: reply, type: "text" }] });

it.effect(
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

it.effect(
	"SubagentStop checks nothing for another subagent, a session's internal agent, or a pinned subagent in auto mode, which hands back through SubagentHandback",
	() =>
		Effect.gen(function* skipped() {
			const stops = [subagentStop("Explore", "default"), subagentStop("", "default"), subagentStop(pinned, "auto")];

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

it.effect(
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

it.effect(
	"the pinned subagent's Agent result reaches the root agent as the reply when its answer was withheld, and unchanged otherwise",
	() =>
		Effect.gen(function* delivered() {
			const withheld = [{ reply, subagent: agent }];
			const otherRun = [{ reply, subagent: "a0000000000000000" }];

			const runs = yield* Effect.forEach(
				[
					[pinned, withheld],
					[pinned, otherRun],
					["Explore", withheld],
				] as const,
				([subagentType, listed]) => hookRun(agentResult(subagentType), { outcome: cleared, withheld: listed }),
				{ concurrency: 1 },
			);

			assert.deepStrictEqual(runs, [
				Struct.assign(ran(["status"]), {
					shown: Option.some<Schema.Json>({
						hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: replacedResponse },
					}),
				}),
				ran(["status"]),
				ran([]),
			]);
		}),
);
