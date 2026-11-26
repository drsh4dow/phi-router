import type { AnswerCheck, AnswerChecked } from "#shared/cli.ts";
import { Array, Console, Effect, Match, Option, Schema, Struct, pipe } from "effect";
import { SessionRequests } from "#router/client/router-port/index.ts";
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

const Delivered = Schema.Struct({
	hook_event_name: Schema.Literal("PostToolUse"),
	session_id: Schema.NonEmptyString,
	tool_input: Schema.Struct({ subagent_type: Schema.optionalKey(Schema.String) }),
	tool_name: Schema.Literal("Agent"),
	tool_response: Schema.StructWithRest(Schema.Struct({ agentId: Schema.String }), [Fields]),
});

const HookInput = Schema.fromJsonString(Schema.Union([AnswerGiven, HandedBack, Delivered]));

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

const deliveredOf = Effect.fnUntraced(function* deliveredOf(port: number, delivered: typeof Delivered.Type) {
	if (delivered.tool_input.subagent_type !== claudePinnedAgent) {
		return printedNothing;
	}

	const requests = yield* SessionRequests;

	const status = yield* Effect.mapError(
		requests.status(port, delivered.session_id),
		failedAs({ command: "status", port }),
	);

	const replaced = pipe(
		Option.fromUndefinedOr(status.pinned),
		Option.flatMap(({ withheld }) =>
			Array.findFirst(withheld, ({ subagent }) => subagent === delivered.tool_response.agentId),
		),
		Option.map(({ reply }) =>
			Schema.encodeEffect(ReplacedResult)({
				hookSpecificOutput: {
					hookEventName: "PostToolUse",
					updatedToolOutput: Struct.assign(delivered.tool_response, { content: [{ text: reply, type: "text" }] }),
				},
			}),
		),
	);

	return yield* Effect.transposeOption(replaced);
});

const answered = Effect.fnUntraced(function* answered(port: number, text: string) {
	const input = yield* Schema.decodeEffect(HookInput)(text);

	return yield* Match.value(input).pipe(
		Match.discriminatorsExhaustive("hook_event_name")({
			PostToolUse: (delivered) => deliveredOf(port, delivered),
			PreToolUse: (handedBack) => handedBackOf(port, handedBack),
			SubagentStop: (given) => stopped(port, given),
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
