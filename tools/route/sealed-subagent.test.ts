import { Array, Effect, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { bridgesFor, sealedStub } from "#router/features/border/index.ts";
import { handleAt } from "#router/primitives/handle.ts";
import {
	clean,
	harnessNames,
	holdsCanary,
	linesIn,
	modelsIn,
	phi,
	pinnedModelOf,
	posted,
	sentModels,
} from "./target-models.ts";
import { fakes, laneLines, routed } from "./mocked-router.ts";
import { pinnedLine, pinnedModel } from "#router/features/lanes/index.ts";
import type { HarnessName } from "./target-models.ts";
import type { Json } from "./harnesses.ts";
import { NodeServices } from "@effect/platform-node";
import type { Post } from "./mocked-router.ts";
import { jsonText } from "./harnesses.ts";

const vendorOf: Readonly<Record<HarnessName, keyof typeof fakes.sealedModel>> = {
	claude: "anthropic",
	codex: "openai",
	pi: "anthropic",
};

const ok = 200;

const none = 0;

const pinnedByName = Effect.fnUntraced(function* pinnedByName(harness: HarnessName) {
	const { mocks, post, state } = yield* routed({
		configExtras: { sealedModel: fakes.sealedModel },
		harness,
		holdsPhi: holdsCanary,
	});

	const asked = [[clean], [phi]];

	const statuses = yield* Effect.forEach(
		asked,
		(turns, at) => posted(post, { harness, model: pinnedModelOf[harness], session: `sealed-${String(at)}` }, turns),
		{ concurrency: 1 },
	);

	const model = fakes.sealedModel[vendorOf[harness]];
	const bridge = yield* jsonText(bridgesFor[harness]);
	const sealed = yield* mocks.baa.received;
	const judged = yield* mocks.judge.received;
	const opened = yield* mocks.open.received;

	assert.deepStrictEqual<unknown>(
		{
			bridged: pipe(
				sealed,
				Array.some(({ body }) => Str.includes(bridge)(body)),
			),
			judged: judged.length,
			lines: yield* linesIn(state),
			models: yield* modelsIn(sealed),
			opened: opened.length,
			statuses,
		},
		{
			bridged: false,
			judged: none,
			lines: Array.replicate(["baa", "sealed", model, false, "pinned"], asked.length),
			models: Array.replicate(model, asked.length),
			opened: none,
			statuses: Array.replicate(ok, asked.length),
		},
	);
});

const claudeBody = (sent: {
	readonly model: string;
	readonly system: string;
	readonly text: string;
}): Effect.Effect<string> =>
	Effect.orDie(
		jsonText({
			max_tokens: 1024,
			messages: [{ content: [{ text: sent.text, type: "text" }], role: "user" }],
			model: sent.model,
			stream: true,
			system: [{ text: sent.system, type: "text" }],
		}),
	);

const pinnedSubagentSystemPrompt = `${pinnedLine}\nRead your sources again with your tools.`;

const postBody = Effect.fnUntraced(function* postBody(
	post: Post,
	sent: { readonly session: string; readonly body: string },
) {
	const response = yield* post(sent);

	yield* response.text;
});

const pinnedByLine = Effect.fnUntraced(function* pinnedByLine(harness: "claude" | "pi") {
	const { mocks, post, state } = yield* routed({ harness, holdsPhi: holdsCanary });

	const inSystem = yield* claudeBody({
		model: sentModels.claudeHaiku,
		system: pinnedSubagentSystemPrompt,
		text: clean.text,
	});

	const inPrompt = yield* claudeBody({
		model: sentModels.claudeHaiku,
		system: "",
		text: `${pinnedLine} ${clean.text}`,
	});

	yield* postBody(post, { body: inSystem, session: "line-system" });

	const judgedPinned = yield* mocks.judge.received;

	yield* postBody(post, { body: inPrompt, session: "line-prompt" });

	const judged = yield* mocks.judge.received;
	const sealed = yield* mocks.baa.received;
	const opened = yield* mocks.open.received;

	assert.deepStrictEqual<unknown>(
		{
			baa: yield* modelsIn(sealed),
			judgedPinned: judgedPinned.length,
			judgedPrompt: judged.length > judgedPinned.length,
			lines: yield* linesIn(state),
			open: yield* modelsIn(opened),
		},
		{
			baa: [sentModels.claudeHaiku],
			judgedPinned: none,
			judgedPrompt: true,
			lines: [
				["baa", "sealed", sentModels.claudeHaiku, false, "pinned"],
				["open", "clean", sentModels.claudeHaiku, false, "clean"],
			],
			open: [sentModels.claudeHaiku],
		},
	);
});

const session = "parent-1";

const beforeTheAnswer = 1;

const callId = "toolu_subagent";

const askedParent: Json = {
	content: [{ text: "Hand the record check to the phi-sealed subagent.", type: "text" }],
	role: "user",
};

const handedOver: readonly Json[] = [
	askedParent,
	{
		content: [{ id: callId, input: { prompt: "Find the member's internal id." }, name: "Agent", type: "tool_use" }],
		role: "assistant",
	},
	{
		content: [{ content: `${phi.text} Their internal id is p-17.`, tool_use_id: callId, type: "tool_result" }],
		role: "user",
	},
];

const afterwards: readonly Json[] = [
	...handedOver,
	{ content: [{ text: "The subagent found p-17.", type: "text" }], role: "assistant" },
	{ content: [{ text: "Thanks. What is next?", type: "text" }], role: "user" },
];

const parentBody = (messages: readonly Json[]): Effect.Effect<string> =>
	Effect.orDie(jsonText({ max_tokens: 1024, messages, model: "phi/auto", stream: true }));

const handedOff = Effect.fnUntraced(function* handedOff(post: Post) {
	const [asking = "", answered = "", following = ""] = yield* Effect.forEach(
		[[askedParent], handedOver, afterwards],
		parentBody,
		{ concurrency: 1 },
	);

	yield* postBody(post, { body: asking, session });
	yield* posted(post, { harness: "claude", model: pinnedModel, session }, [{ role: "user", text: "Find p-17." }]);
	yield* postBody(post, { body: answered, session });
	yield* postBody(post, { body: following, session });
});

const answerJudged = Effect.gen(function* answerJudged() {
	const { mocks, post, state } = yield* routed({ holdsPhi: holdsCanary });

	yield* handedOff(post);

	const opened = yield* mocks.open.received;
	const lines = yield* laneLines(state);
	const stub = yield* jsonText(sealedStub("claude")(handleAt(1)));
	const stubbedResult = `{"tool_use_id":"${callId}","type":"tool_result","content":${stub}}`;

	assert.deepStrictEqual<unknown>(
		{
			canaryOpened: pipe(
				opened,
				Array.some(({ body }) => holdsCanary(body)),
			),
			lines: pipe(
				lines,
				Array.map(({ account, reason }) => [account, reason]),
			),
			stubbed: pipe(
				opened,
				Array.drop(beforeTheAnswer),
				Array.map(({ body }) => Str.includes(stubbedResult)(body)),
			),
		},
		{
			canaryOpened: false,
			lines: [
				["open", "clean"],
				["baa", "pinned"],
				["open", "clean"],
				["open", "clean"],
			],
			stubbed: [true, true],
		},
	);
});

it.layer(NodeServices.layer)("the pinned subagent", (test) => {
	test.effect.each(harnessNames)(
		"%s: a request that names phi/sealed runs on the BAA account under the sealed model, with no judge call and nothing at the open account",
		pinnedByName,
	);
	test.effect.each(["claude", "pi"] as const)(
		"%s: the pinned line in the system prompt pins a request to the BAA account under the model its main agent picked, with no judge call, and in a user message pins nothing",
		pinnedByLine,
	);
	test.effect(
		"the parent asks on the open account and its pinned subagent runs on the BAA account; the subagent's answer that holds a canary, back as a tool result, is sealed in the parent session, and each later parent request reaches the open account with the stub in place of it",
		() => answerJudged,
	);
});
