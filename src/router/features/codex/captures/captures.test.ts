import { Array, Effect, Option, Predicate, Schema, String as Str, pipe } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { requests } from "./index.ts";

const Part = Schema.Struct({ type: Schema.String });

const Parts = Schema.NullOr(Schema.Array(Part));

const Item = Schema.Struct({
	arguments: Schema.optionalKey(Schema.String),
	content: Schema.optionalKey(Parts),
	name: Schema.optionalKey(Schema.String),
	type: Schema.String,
});

const TurnMetadata = Schema.fromJsonString(
	Schema.Struct({ request_kind: Schema.String, session_id: Schema.String, thread_source: Schema.String }),
);

const optionalTools = Schema.optionalKey(Schema.Array(Schema.Unknown));

const Captured = Schema.fromJsonString(
	Schema.Struct({
		client_metadata: Schema.Struct({ "x-codex-turn-metadata": TurnMetadata }),
		input: Schema.Array(Item),
		model: Schema.String,
		tools: optionalTools,
	}),
);

const SpawnArguments = Schema.fromJsonString(Schema.Struct({ message: Schema.String }));

const decodeCaptured = Schema.decodeUnknownEffect(Captured);

const decodeSpawn = Schema.decodeUnknownEffect(SpawnArguments);

const encryptedPrefix = "gAAAAA";

const captured = (text: string): Effect.Effect<typeof Captured.Type> => Effect.orDie(decodeCaptured(text));

const turnOf = (text: string): Effect.Effect<typeof TurnMetadata.Type> =>
	Effect.map(captured(text), ({ client_metadata: metadata }) => metadata["x-codex-turn-metadata"]);

const typesOf = (text: string): Effect.Effect<readonly string[]> =>
	Effect.map(captured(text), ({ input }) =>
		pipe(
			input,
			Array.map(({ type }) => type),
		),
	);

const requestKinds = Effect.gen(function* requestKinds() {
	const kinds = yield* Effect.all(
		pipe(
			requests,
			Array.fromRecord,
			Array.map(([name, text]) => Effect.map(turnOf(text), ({ request_kind: kind }) => `${name}: ${kind}`)),
		),
		{ concurrency: 1 },
	);

	assert.deepStrictEqual(kinds, [
		"compaction: compaction",
		"customToolCall: turn",
		"firstTurn: turn",
		"functionCall: turn",
		"resumed: turn",
		"subagent: turn",
		"subagentParent: turn",
	]);
});

const dialectOf = (
	text: string,
): Effect.Effect<{
	readonly firstItem: Option.Option<string>;
	readonly model: string;
	readonly topLevelTools: boolean;
}> =>
	Effect.map(captured(text), ({ input, model, tools }) => ({
		firstItem: Option.map(Array.head(input), ({ type }) => type),
		model,
		topLevelTools: Predicate.isNotUndefined(tools),
	}));

const dialects = Effect.gen(function* dialects() {
	const lite = yield* dialectOf(requests.firstTurn);
	const fallback = yield* dialectOf(requests.functionCall);

	assert.deepStrictEqual(
		{ fallback, lite },
		{
			fallback: { firstItem: Option.some("message"), model: "phi/sealed", topLevelTools: true },
			lite: { firstItem: Option.some("additional_tools"), model: "phi/auto", topLevelTools: false },
		},
	);
});

const endsWith = (types: readonly string[], last: readonly string[]): void => {
	assert.deepStrictEqual(Array.takeRight(types, last.length), last);
};

const replyRuns = Effect.gen(function* replyRuns() {
	const custom = yield* typesOf(requests.customToolCall);
	const call = yield* typesOf(requests.functionCall);

	endsWith(custom, ["reasoning", "message", "custom_tool_call", "custom_tool_call_output"]);
	endsWith(call, ["reasoning", "function_call", "function_call_output"]);
});

const resumedSession = Effect.gen(function* resumedSession() {
	const before = yield* turnOf(requests.customToolCall);
	const after = yield* turnOf(requests.resumed);
	const beforeTypes = yield* typesOf(requests.customToolCall);
	const afterTypes = yield* typesOf(requests.resumed);

	assert.strictEqual(after.session_id, before.session_id);
	assert.deepStrictEqual(Array.take(afterTypes, beforeTypes.length), beforeTypes);
	assert.isAbove(afterTypes.length, beforeTypes.length);
});

const subagentTask = Effect.gen(function* subagentTask() {
	const turn = yield* turnOf(requests.subagent);
	const { input } = yield* captured(requests.subagent);

	const taskParts = pipe(
		input,
		Array.findLast(({ type }) => type === "agent_message"),
		Option.flatMap(({ content }) => Option.fromNullishOr(content)),
		Option.map(Array.map(({ type }) => type)),
	);

	assert.deepStrictEqual(
		{ encrypted: Option.exists(taskParts, Array.contains("encrypted_content")), source: turn.thread_source },
		{ encrypted: true, source: "subagent" },
	);
});

const spawnMessages = Effect.gen(function* spawnMessages() {
	const { input } = yield* captured(requests.subagentParent);

	const spawns = pipe(
		input,
		Array.filter(({ name }) => name === "spawn_agent"),
	);

	const messages = yield* Effect.forEach(spawns, ({ arguments: args = "" }) => Effect.orDie(decodeSpawn(args)), {
		concurrency: 1,
	});

	assert.deepStrictEqual(
		pipe(
			messages,
			Array.map(({ message }) => Str.startsWith(encryptedPrefix)(message)),
		),
		[true, true],
	);
});

describe("what each capture of Codex 0.166.0 shows", () => {
	it.effect("only the compaction request, which /compact sends, has the request kind compaction", () => requestKinds);
	it.effect(
		"phi/auto, which the catalog lists, gets the lite dialect with its tools in an additional_tools item, and phi/sealed the fallback with top-level tools",
		() => dialects,
	);
	it.effect(
		"the custom tool call turn ends with a reply's reasoning, message and custom tool call, then its output, and the function call turn likewise",
		() => replyRuns,
	);
	it.effect(
		"the resumed turn goes on in the custom tool call turn's session with each of its items and more",
		() => resumedSession,
	);
	it.effect(
		"the subagent's request comes from a subagent, with its task as an encrypted agent message",
		() => subagentTask,
	);
	it.effect("each spawn_agent call of the subagent's parent carries its message encrypted", () => spawnMessages);
});
