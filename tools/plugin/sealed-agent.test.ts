import { Effect, String as Str } from "effect";
import { assert, it } from "@effect/vitest";
import { claudePinnedAgent, sealedStub } from "#router/features/border/index.ts";
import { pinnedLine, pinnedModel } from "#router/features/lanes/index.ts";
import { NodeServices } from "@effect/platform-node";
import { handleAt } from "#router/primitives/handle.ts";
import { pinnedSubagent } from "./agent-file.ts";
import { sealedRole } from "#router/features/cli/index.ts";

const firstSequence = 1;

const h1 = handleAt(firstSequence);

const shipped = Effect.gen(function* shipped() {
	const agent = yield* pinnedSubagent;

	assert.deepStrictEqual(
		{
			agentName: claudePinnedAgent === `${agent.pluginName}:${agent.name}`,
			describedWithoutLine: !Str.includes(pinnedLine)(agent.description),
			model: agent.model,
			namesHandles:
				Str.includes("[sealed hN]")(agent.description) && Str.includes("names each handle")(agent.description),
			opensWithLine: Str.startsWith(`${pinnedLine}\n`)(agent.body),
			readsAgain: Str.includes("again with your tools")(agent.body),
			roleDescription: Str.includes(`description = "${agent.description}"\n`)(sealedRole),
			roleInstructions: Str.includes(`developer_instructions = """\n${agent.body}"""\n`)(sealedRole),
			stubsNameIt: [
				Str.includes(`the ${agent.pluginName}:${agent.name} subagent`)(sealedStub("claude")(h1)),
				Str.includes(`the ${agent.name} subagent`)(sealedStub("codex")(h1)),
			],
		},
		{
			agentName: true,
			describedWithoutLine: true,
			model: pinnedModel,
			namesHandles: true,
			opensWithLine: true,
			readsAgain: true,
			roleDescription: true,
			roleInstructions: true,
			stubsNameIt: [true, true],
		},
	);
});

it.layer(NodeServices.layer)("the plugin's pinned subagent", (test) => {
	test.effect(
		"runs on phi/sealed, is started with a scoped task naming handles, opens its instructions with the pinned line and rereads its sources, the Codex role carries the same description and instructions, and the Claude Code and Codex stubs and the answer-check hook name it",
		() => shipped,
	);
});
