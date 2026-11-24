import { Array, Effect, String as Str, Struct, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { jsonText, userMessage } from "./harnesses.ts";
import { laneLines, routed } from "./mocked-router.ts";
import { NodeServices } from "@effect/platform-node";

const prompt = "Generate a concise, single-line task title.\n\nUser prompt:\nWhat time is the build on Fridays?";

const noJudgeCall = 0;

const titleBody = (turn: string, beside: Readonly<Record<string, string>> = {}): Effect.Effect<string> =>
	Effect.map(
		jsonText({
			client_metadata: Struct.assign(beside, { "x-codex-turn-metadata": turn }),
			include: [],
			input: [userMessage(prompt)],
			parallel_tool_calls: false,
			reasoning: { summary: "auto" },
			store: false,
			stream: true,
			tool_choice: "auto",
		}),
		Str.replace(/^\{/u, '{"model":"phi/auto",'),
	);

const routedAs = Effect.fnUntraced(function* routedAs(body: string) {
	const { mocks, post, state } = yield* routed({ harness: "codex", holdsPhi: () => false });
	const response = yield* post({ body, session: "codex-title" });

	yield* response.text;

	const lines = yield* laneLines(state);
	const open = yield* mocks.open.received;
	const baa = yield* mocks.baa.received;
	const judge = yield* mocks.judge.received;

	return {
		baa: baa.length,
		judge: judge.length,
		lines: pipe(
			lines,
			Array.map(({ account, lane, reason }) => [account, lane, reason]),
		),
		open: open.length,
		status: response.status,
	};
}, Effect.scoped);

const sealedAsTitle = { baa: 1, judge: noJudgeCall, lines: [["baa", "sealed", "title"]], open: 0, status: 200 };

const titleRequests = Effect.gen(function* titleRequests() {
	const compact = yield* titleBody('{"thread_source":"thread_title"}').pipe(Effect.flatMap(routedAs));
	const spaced = yield* titleBody('{ "thread_source": "thread_title" }').pipe(Effect.flatMap(routedAs));

	const unreadKey = yield* titleBody('{"thread_source":"thread_title"}', { unread: "1" }).pipe(
		Effect.flatMap(routedAs),
	);

	assert.deepStrictEqual(
		{ compact, spaced, unreadKey },
		{ compact: sealedAsTitle, spaced: sealedAsTitle, unreadKey: sealedAsTitle },
	);
});

const userTurn = Effect.gen(function* userTurn() {
	const user = yield* titleBody('{"thread_source":"user"}').pipe(Effect.flatMap(routedAs));

	assert.deepStrictEqual(Struct.omit(user, ["judge"]), {
		baa: 0,
		lines: [["open", "clean", "clean"]],
		open: 1,
		status: 200,
	});
	assert.isAbove(user.judge, noJudgeCall);
});

it.layer(NodeServices.layer)("Codex's thread-title request", (test) => {
	test.effect(
		"goes sealed as title with no judge call, whether its turn metadata is compact, spaced or beside a key the codec does not read",
		() => titleRequests,
	);
	test.effect("the same body from a user turn is judged and goes open", () => userTurn);
});
