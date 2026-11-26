import { Array, Option, Predicate, Schema, String as Str, pipe } from "effect";

interface HandBack {
	readonly text: string;
	readonly fromSubagent: boolean;
}

const ResultEvent = Schema.Struct({ result: Schema.String, type: Schema.Literal("result") });

const TextBlock = Schema.Struct({ text: Schema.String, type: Schema.Literal("text") });

const HandBackCall = Schema.Struct({
	id: Schema.String,
	input: Schema.Struct({ message: Schema.String }),
	name: Schema.Literal("SubagentHandback"),
	type: Schema.Literal("tool_use"),
});

const ToolUse = Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.Literal("tool_use") });

const ToolResult = Schema.Struct({
	content: Schema.Union([Schema.String, Schema.Array(TextBlock)]),
	is_error: Schema.optionalKey(Schema.Boolean),
	tool_use_id: Schema.String,
	type: Schema.Literal("tool_result"),
});

const OtherBlock = Schema.Struct({ type: Schema.String });

const Block = Schema.Union([HandBackCall, ToolUse, ToolResult, TextBlock, OtherBlock]);

const MessageEvent = Schema.Struct({
	message: Schema.Struct({ content: Schema.Array(Block) }),
	parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	type: Schema.Literals(["assistant", "user"]),
});

const TaskNotification = Schema.Struct({
	status: Schema.String,
	subtype: Schema.Literal("task_notification"),
	summary: Schema.String,
	tool_use_id: Schema.String,
	type: Schema.Literal("system"),
});

const StreamEvent = Schema.Union([ResultEvent, MessageEvent, TaskNotification]);

type Event = typeof StreamEvent.Type;

type Message = typeof MessageEvent.Type;

const Wake = Schema.Struct({ outcome: Schema.Struct({ status: Schema.String, text: Schema.String }) });

const PiHarnessOutcome = Schema.Struct({
	answer: Schema.String,
	delegates: Schema.Array(Schema.String),
	wakes: Schema.Array(Schema.fromJsonString(Wake)),
});

type Outcome = typeof PiHarnessOutcome.Type;

const eventIn = Schema.decodeOption(Schema.fromJsonString(StreamEvent));

const outcomeIn = Schema.decodeOption(Schema.fromJsonString(PiHarnessOutcome));

const outcomeLine = "phi-accounts ";

const decodeEvent = (line: string): Option.Option<Event> => eventIn(line);

const decodeOutcome = (line: string): Option.Option<Outcome> =>
	pipe(
		Option.liftPredicate(line, Str.startsWith(outcomeLine)),
		Option.flatMap((printed) => outcomeIn(Str.slice(outcomeLine.length)(printed))),
	);

const eventsIn = (lines: readonly string[]): readonly Event[] => pipe(lines, Array.map(decodeEvent), Array.getSomes);

const outcomesIn = (lines: readonly string[]): readonly Outcome[] =>
	pipe(lines, Array.map(decodeOutcome), Array.getSomes);

const answersIn = (lines: readonly string[]): readonly string[] => {
	const fromClaude = pipe(
		eventsIn(lines),
		Array.filter(Schema.is(ResultEvent)),
		Array.map(({ result }) => result),
	);

	const fromPiHarness = pipe(
		outcomesIn(lines),
		Array.map(({ answer }) => answer),
	);

	return pipe([...fromClaude, ...fromPiHarness], Array.filter(Str.isNonEmpty));
};

const textOf = (content: string | readonly (typeof TextBlock.Type)[]): string => {
	if (Predicate.isString(content)) {
		return content;
	}

	return pipe(
		content,
		Array.map(({ text }) => text),
		Array.join("\n"),
	);
};

const blocksOf = (messages: readonly Message[]): readonly (typeof Block.Type)[] =>
	pipe(
		messages,
		Array.flatMap(({ message }) => message.content),
	);

const resultsOf = (blocks: readonly (typeof Block.Type)[]): readonly (typeof ToolResult.Type)[] =>
	pipe(blocks, Array.filter(Schema.is(ToolResult)));

const claudeHandBack = (events: readonly Event[]): Option.Option<HandBack> => {
	const messages = pipe(events, Array.filter(Schema.is(MessageEvent)));

	const own = pipe(
		messages,
		Array.filter(({ parent_tool_use_id: parent }) => Predicate.isNullish(parent)),
	);

	const agentCalls = pipe(
		blocksOf(own),
		Array.filter(Schema.is(ToolUse)),
		Array.filter(({ name }) => name === "Agent"),
		Array.map(({ id }) => id),
	);

	const isAgentCall = (id: string): boolean => pipe(agentCalls, Array.contains(id));

	const subagent = blocksOf(
		pipe(
			messages,
			Array.filter(({ parent_tool_use_id: parent }) => isAgentCall(parent ?? "")),
		),
	);

	const calls = pipe(subagent, Array.filter(Schema.is(HandBackCall)));

	const refused = pipe(
		resultsOf(subagent),
		Array.filter(({ is_error: failed = false }) => failed),
		Array.map(({ tool_use_id: id }) => id),
	);

	const words = [
		...pipe(
			subagent,
			Array.filter(Schema.is(TextBlock)),
			Array.map(({ text }) => text),
		),
		...pipe(
			calls,
			Array.map(({ input }) => input.message),
		),
	];

	const handedBack = pipe(
		calls,
		Array.filter(({ id }) => !pipe(refused, Array.contains(id))),
		Array.map(({ input }) => input.message),
	);

	const notified = pipe(
		events,
		Array.flatMap((event): readonly { readonly id: string; readonly text: string }[] => {
			if (Schema.is(TaskNotification)(event)) {
				return [{ id: event.tool_use_id, text: event.summary }];
			}

			if (Schema.is(MessageEvent)(event) && Predicate.isNullish(event.parent_tool_use_id)) {
				return pipe(
					resultsOf(event.message.content),
					Array.map(({ content, tool_use_id: id }) => ({ id, text: textOf(content) })),
				);
			}

			return [];
		}),
		Array.filter(({ id }) => isAgentCall(id)),
		Array.map(({ text }) => text),
	);

	return Option.map(Array.last(Array.appendAll(notified, handedBack)), (text) => ({
		fromSubagent: pipe(words, Array.contains(text)),
		text,
	}));
};

const piHarnessHandBack = (outcomes: readonly Outcome[]): Option.Option<HandBack> =>
	pipe(
		outcomes,
		Array.flatMap(({ wakes }) => wakes),
		Array.last,
		Option.map(({ outcome }) => ({ fromSubagent: outcome.status === "done", text: outcome.text })),
	);

const handBackIn = (lines: readonly string[]): Option.Option<HandBack> =>
	Option.orElse(claudeHandBack(eventsIn(lines)), () => piHarnessHandBack(outcomesIn(lines)));

export { answersIn, handBackIn };
