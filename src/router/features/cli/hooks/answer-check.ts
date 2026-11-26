import type { AnswerCheck, AnswerChecked, Pinned } from "#shared/cli.ts";
import { Array, Console, Effect, Match, Option, Schema, String as Str, Struct, pipe } from "effect";
import { ClaudeSubagents } from "#router/client/harnesses/index.ts";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { answerKey } from "#router/features/answer-check/index.ts";
import { claudePinnedAgent } from "#router/features/border/index.ts";
import { failedAs } from "#router/features/cli/sessions/index.ts";
import { portOf } from "./session-start.ts";
import { standardInput } from "#router/client/standard-input.ts";

const rewriteExit = 2;

class RewriteAsked extends Schema.TaggedError<RewriteAsked, { readonly brand: unique symbol }>()("RewriteAsked", {
	reason: Schema.String,
}) {}

const Fields = Schema.Record(Schema.String, Schema.Unknown);

const AnswerGiven = Schema.Struct({
	agent_id: Schema.NonEmptyString,
	agent_type: Schema.String,
	hook_event_name: Schema.Literal("SubagentStop"),
	last_assistant_message: Schema.String,
	permission_mode: Schema.optionalKey(Schema.String),
	session_id: Schema.NonEmptyString,
});

const HandedBack = Schema.Struct({
	agent_id: Schema.NonEmptyString,
	agent_type: Schema.String,
	hook_event_name: Schema.Literal("PreToolUse"),
	session_id: Schema.NonEmptyString,
	tool_input: Schema.StructWithRest(Schema.Struct({ message: Schema.String }), [Fields]),
	tool_name: Schema.Literal("SubagentHandback"),
});

const TextBlock = Schema.Struct({ text: Schema.optionalKey(Schema.String) });

const AgentResult = Schema.Struct({
	agentId: Schema.String,
	content: Schema.optionalKey(Schema.Array(TextBlock)),
	harnessNoteCount: Schema.optionalKey(Schema.Int),
	harnessTailCount: Schema.optionalKey(Schema.Int),
});

const noNotes = 0;

const Delivered = Schema.Struct({
	hook_event_name: Schema.Literal("PostToolUse"),
	session_id: Schema.NonEmptyString,
	tool_input: Schema.Struct({ subagent_type: Schema.optionalKey(Schema.String) }),
	tool_name: Schema.Literal("Agent"),
	tool_response: Schema.StructWithRest(AgentResult, [Fields]),
});

const Notified = Schema.Struct({
	hook_event_name: Schema.Literal("UserPromptSubmit"),
	prompt: Schema.String,
	session_id: Schema.NonEmptyString,
	transcript_path: Schema.String,
});

const HookInput = Schema.fromJsonString(Schema.Union([AnswerGiven, HandedBack, Delivered, Notified]));

const handback = Schema.Literal("PreToolUse");

const Denied = Schema.Struct({
	hookEventName: handback,
	permissionDecision: Schema.Literal("deny"),
	permissionDecisionReason: Schema.String,
});

const Replaced = Schema.Struct({
	hookEventName: handback,
	permissionDecision: Schema.Literal("allow"),
	updatedInput: Fields,
});

const HandbackDecision = Schema.fromJsonString(Schema.Struct({ hookSpecificOutput: Schema.Union([Denied, Replaced]) }));

const ResultReplaced = Schema.Struct({ hookEventName: Schema.Literal("PostToolUse"), updatedToolOutput: Fields });

const ReplacedResult = Schema.fromJsonString(Schema.Struct({ hookSpecificOutput: ResultReplaced }));

const PromptSuppressed = Schema.Struct({
	hookEventName: Schema.Literal("UserPromptSubmit"),
	suppressOriginalPrompt: Schema.Literal(true),
});

const NotificationBlocked = Schema.fromJsonString(
	Schema.Struct({ decision: Schema.Literal("block"), hookSpecificOutput: PromptSuppressed, reason: Schema.String }),
);

type Printed = Option.Option<string>;

const printedNothing: Printed = Option.none();

const autoMode = "auto";

const checked = Effect.fnUntraced(function* checked(port: number, asked: typeof AnswerCheck.Type) {
	const requests = yield* SessionRequests;

	return yield* Effect.mapError(requests.answerCheck(port, asked), failedAs({ command: "answer-check", port }));
});

const stopped = Effect.fnUntraced(function* stopped(port: number, given: typeof AnswerGiven.Type) {
	if (given.agent_type !== claudePinnedAgent || given.permission_mode === autoMode) {
		return printedNothing;
	}

	const outcome = yield* checked(port, {
		answer: given.last_assistant_message,
		session: given.session_id,
		subagent: given.agent_id,
	});

	if (outcome.outcome === "rewrite") {
		return yield* RewriteAsked.make({ reason: outcome.message });
	}

	return printedNothing;
});

type Decision = Option.Option<typeof Denied.Type | typeof Replaced.Type>;

const decisionOf = (handedBack: typeof HandedBack.Type): ((outcome: typeof AnswerChecked.Type) => Decision) =>
	Match.type<typeof AnswerChecked.Type>().pipe(
		Match.discriminatorsExhaustive("outcome")({
			cleared: () => Option.none(),
			"gave-up": ({ reply }) =>
				Option.some<typeof Replaced.Type>({
					hookEventName: "PreToolUse",
					permissionDecision: "allow",
					updatedInput: Struct.assign(handedBack.tool_input, { message: reply }),
				}),
			rewrite: ({ message }) =>
				Option.some<typeof Denied.Type>({
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: message,
				}),
		}),
	);

const handedBackOf = Effect.fnUntraced(function* handedBackOf(port: number, handedBack: typeof HandedBack.Type) {
	if (handedBack.agent_type !== claudePinnedAgent) {
		return printedNothing;
	}

	const outcome = yield* checked(port, {
		answer: handedBack.tool_input.message,
		session: handedBack.session_id,
		subagent: handedBack.agent_id,
	});

	const decided = pipe(
		decisionOf(handedBack)(outcome),
		Option.map((hookSpecificOutput) => Schema.encodeEffect(HandbackDecision)({ hookSpecificOutput })),
	);

	return yield* Effect.transposeOption(decided);
});

const uncheckedReply = (why: string): string =>
	`phi-router could not check the pinned subagent's answer, so it withheld it: ${why}`;

const neverCleared = "phi-router has no record that it cleared this answer.";

interface Delivery {
	readonly answer: string;
	readonly session: string;
	readonly subagent: string;
}

const withheldFrom =
	(delivery: Delivery, key: string) =>
	(pinned: typeof Pinned.Type): Option.Option<string> => {
		const withheld = pipe(
			pinned.withheld,
			Array.findFirst(({ subagent }) => subagent === delivery.subagent),
		);

		if (Option.isSome(withheld)) {
			return Option.some(withheld.value.reply);
		}

		const cleared = pipe(
			pinned.cleared,
			Array.some((each) => each.subagent === delivery.subagent && each.key === key),
		);

		if (cleared) {
			return Option.none();
		}

		return Option.some(uncheckedReply(neverCleared));
	};

const heldBack = Effect.fnUntraced(function* heldBack(port: number, delivery: Delivery) {
	const requests = yield* SessionRequests;
	const key = yield* answerKey(delivery.answer);

	return yield* requests.status(port, delivery.session).pipe(
		Effect.map(({ pinned }) =>
			Option.match(Option.fromUndefinedOr(pinned), {
				onNone: () => Option.some(uncheckedReply(neverCleared)),
				onSome: withheldFrom(delivery, key),
			}),
		),
		Effect.catch((error) => Effect.succeedSome(uncheckedReply(failedAs({ command: "status", port })(error).message))),
	);
});

const deliveredOf = Effect.fnUntraced(function* deliveredOf(port: number, delivered: typeof Delivered.Type) {
	const content = Option.fromUndefinedOr(delivered.tool_response.content);

	if (delivered.tool_input.subagent_type !== claudePinnedAgent || Option.isNone(content)) {
		return printedNothing;
	}

	const { harnessNoteCount = noNotes, harnessTailCount = noNotes } = delivered.tool_response;

	const answer = pipe(
		content.value,
		Array.drop(harnessNoteCount),
		Array.dropRight(harnessTailCount),
		Array.flatMap(({ text }) => Option.toArray(Option.fromUndefinedOr(text))),
		Array.join("\n"),
	);

	const held = yield* heldBack(port, {
		answer,
		session: delivered.session_id,
		subagent: delivered.tool_response.agentId,
	});

	const replaced = pipe(
		held,
		Option.map((reply) =>
			Schema.encodeEffect(ReplacedResult)({
				hookSpecificOutput: {
					hookEventName: "PostToolUse",
					updatedToolOutput: Struct.assign(delivered.tool_response, {
						content: [{ text: reply, type: "text" }],
						harnessNoteCount: noNotes,
						harnessTailCount: noNotes,
					}),
				},
			}),
		),
	);

	return yield* Effect.transposeOption(replaced);
});

const notification =
	/^<task-notification>\n<task-id>(?<subagent>[^<]+)<\/task-id>[\s\S]*<result>(?<result>[\s\S]*)<\/result>/u;

const unescaped = (text: string): string =>
	pipe(text, Str.replaceAll("&lt;", "<"), Str.replaceAll("&gt;", ">"), Str.replaceAll("&amp;", "&"));

const notifiedOf = Effect.fnUntraced(function* notifiedOf(port: number, notified: typeof Notified.Type) {
	const reported = pipe(
		Str.match(notification)(notified.prompt),
		Option.flatMapNullishOr(({ groups }) => groups),
		Option.flatMap(({ result, subagent }) =>
			Option.all({ result: Option.fromNullishOr(result), subagent: Option.fromNullishOr(subagent) }),
		),
	);

	if (Option.isNone(reported)) {
		return printedNothing;
	}

	const { result, subagent } = reported.value;
	const subagents = yield* ClaudeSubagents;
	const type = yield* subagents.typeOf({ subagent, transcript: notified.transcript_path });

	if (!Option.contains(type, claudePinnedAgent)) {
		return printedNothing;
	}

	const held = yield* heldBack(port, { answer: unescaped(result), session: notified.session_id, subagent });

	const blocked = pipe(
		held,
		Option.map((reason) =>
			Schema.encodeEffect(NotificationBlocked)({
				decision: "block",
				hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true },
				reason,
			}),
		),
	);

	return yield* Effect.transposeOption(blocked);
});

const answered = Effect.fnUntraced(function* answered(port: number, text: string) {
	const input = yield* Schema.decodeEffect(HookInput)(text);

	return yield* Match.value(input).pipe(
		Match.discriminatorsExhaustive("hook_event_name")({
			PostToolUse: (delivered) => deliveredOf(port, delivered),
			PreToolUse: (handedBack) => handedBackOf(port, handedBack),
			SubagentStop: (given) => stopped(port, given),
			UserPromptSubmit: (notified) => notifiedOf(port, notified),
		}),
	);
});

const answerCheck = Effect.fn("answer-check")(function* answerCheck(hook: { readonly address: string }) {
	const port = portOf(hook.address);

	if (Option.isNone(port)) {
		return;
	}

	const text = yield* standardInput;
	const printed = yield* answered(port.value, text);

	if (Option.isSome(printed)) {
		yield* Console.log(printed.value);
	}
});

export { RewriteAsked, answerCheck, answered, rewriteExit };
