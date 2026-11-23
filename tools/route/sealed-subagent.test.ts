import { Array, Effect, Option, String as Str, Struct, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { clean, harnessNames, holdsCanary, linesIn, modelsIn, named, phi, posted } from "./target-models.ts";
import { fakes, laneLines, routed } from "./mocked-router.ts";
import { pinnedLine, pinnedModel } from "#router/features/lanes/index.ts";
import type { HarnessName } from "./target-models.ts";
import type { Json } from "./harnesses.ts";
import { NodeServices } from "@effect/platform-node";
import type { Post } from "./mocked-router.ts";
import { jsonText } from "./harnesses.ts";
import { stubsFor } from "#router/features/border/index.ts";

const vendorOf: Readonly<Record<HarnessName, keyof typeof fakes.sealedModel>> = {
	claude: "anthropic",
	codex: "openai",
	pi: "anthropic",
};

/** How each harness names `phi/sealed`: the pi package sends the id `sealed` inside its provider `phi`. */
const sealedOf: Readonly<Record<HarnessName, string>> = { claude: pinnedModel, codex: pinnedModel, pi: "sealed" };

const ok = 200;

const none = 0;

/**
 * A clean request and a canary request, each naming `phi/sealed` as the harness spells it, reach the BAA account under
 * the configured sealed model with no judge call, and nothing reaches the open account.
 */
const pinnedByName = Effect.fnUntraced(function* pinnedByName(harness: HarnessName) {
	const { mocks, post, state } = yield* routed({
		configured: { sealedModel: fakes.sealedModel },
		harness,
		holdsPhi: holdsCanary,
	});

	const asked = [[clean], [phi]];

	const statuses = yield* Effect.forEach(
		asked,
		(turns, at) => posted(post, { harness, model: sealedOf[harness], session: `sealed-${String(at)}` }, turns),
		{ concurrency: 1 },
	);

	const model = fakes.sealedModel[vendorOf[harness]];
	const sealed = yield* mocks.baa.received;
	const judged = yield* mocks.judge.received;
	const opened = yield* mocks.open.received;

	assert.deepStrictEqual<unknown>(
		{
			judged: judged.length,
			lines: yield* linesIn(state),
			models: yield* modelsIn(sealed),
			opened: opened.length,
			statuses,
		},
		{
			judged: none,
			lines: Array.replicate(["baa", "sealed", model, false, "pinned"], asked.length),
			models: Array.replicate(model, asked.length),
			opened: none,
			statuses: Array.replicate(ok, asked.length),
		},
	);
});

/**
 * A Claude Code body under `model` whose system prompt is `system` and whose one user message is `text`.
 *
 * @param {object} sent The model, the system text, and the user message's text.
 * @returns {Effect.Effect<string>} The body.
 */
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

/** The pinned subagent's instructions, as Claude Code puts its agent file's body in the subagent's system prompt. */
const subagentSystem = `${pinnedLine}\nRead your sources again with your tools.`;

const postBody = Effect.fnUntraced(function* postBody(
	post: Post,
	sent: { readonly session: string; readonly body: string },
) {
	const response = yield* post(sent);

	yield* response.text;
});

/**
 * A subagent request whose system prompt holds the pinned line, under a model its main agent picked, reaches the BAA
 * account under that model with no judge call. The same line in a user message pins nothing.
 */
const pinnedByLine = Effect.fnUntraced(function* pinnedByLine(harness: "claude" | "pi") {
	const { mocks, post, state } = yield* routed({ harness, holdsPhi: holdsCanary });
	const inSystem = yield* claudeBody({ model: named.subagent, system: subagentSystem, text: clean.text });
	const inPrompt = yield* claudeBody({ model: named.subagent, system: "", text: `${pinnedLine} ${clean.text}` });

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
			baa: [named.subagent],
			judgedPinned: none,
			judgedPrompt: true,
			lines: [
				["baa", "sealed", named.subagent, false, "pinned"],
				["open", "clean", named.subagent, false, "clean"],
			],
			open: [named.subagent],
		},
	);
});

const session = "parent-1";

const callId = "toolu_subagent";

const askedParent: Json = {
	content: [{ text: "Hand the record check to the phi-sealed subagent.", type: "text" }],
	role: "user",
};

/** The parent's conversation up to the subagent's answer, which names the patient it read, as its tool result. */
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

/** The parent's question, the pinned subagent's request, the parent's request with its answer, and the next one. */
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

/**
 * The parent asks on the open account, the pinned subagent of the same session runs on the BAA account, and its answer,
 * which holds a canary, comes back as a tool result. That request runs sealed, and the parent's next request reaches
 * the open account with the stub in place of the tool result.
 */
const answerJudged = Effect.gen(function* answerJudged() {
	const { mocks, post, state } = yield* routed({ holdsPhi: holdsCanary });

	yield* handedOff(post);

	const opened = yield* mocks.open.received;
	const lines = yield* laneLines(state);
	const stub = yield* jsonText(stubsFor.claude);
	const stubbedResult = `{"tool_use_id":"${callId}","type":"tool_result","content":${stub}}`;

	const last = pipe(
		Array.last(opened),
		Option.map(Struct.get("body")),
		Option.getOrElse(() => ""),
	);

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
			stubbed: Str.includes(stubbedResult)(last),
		},
		{
			canaryOpened: false,
			lines: [
				["open", "clean"],
				["baa", "pinned"],
				["baa", "sealed new content"],
				["open", "clean"],
			],
			stubbed: true,
		},
	);
});

it.layer(NodeServices.layer)("the pinned subagent", (test) => {
	test.effect.each(harnessNames)(
		"%s: a request that names phi/sealed runs on the BAA account under the sealed model, with no judge call and nothing at the open account",
		pinnedByName,
	);
	test.effect.each(["claude", "pi"] as const)(
		"%s: the pinned line in the system prompt pins a request under any model, and in a user message pins nothing",
		pinnedByLine,
	);
	test.effect(
		"the pinned subagent's answer that holds a canary is sealed in the parent session, and the parent's next open request carries the stub in place of it",
		() => answerJudged,
	);
});
