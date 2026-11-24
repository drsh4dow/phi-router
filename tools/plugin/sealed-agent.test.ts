import { Effect, String as Str } from "effect";
import { assert, it } from "@effect/vitest";
import { pinnedLine, pinnedModel } from "#router/features/lanes/index.ts";
import { NodeServices } from "@effect/platform-node";
import { pinnedSubagent } from "./agent-file.ts";
import { sealedRole } from "#router/features/cli/index.ts";
import { stubsFor } from "#router/features/border/index.ts";

const shipped = Effect.gen(function* shipped() {
	const agent = yield* pinnedSubagent;

	assert.deepStrictEqual(
		{
			describedWithoutLine: !Str.includes(pinnedLine)(agent.description),
			internalIds: Str.includes("Answer with internal ids, your organization's own record ids such as a patient_id")(
				agent.body,
			),
			model: agent.model,
			opensWithLine: Str.startsWith(`${pinnedLine}\n`)(agent.body),
			readsAgain: Str.includes("read your sources again with your tools")(agent.body),
			roleInstructions: Str.includes(`developer_instructions = """\n${agent.body}"""\n`)(sealedRole),
			stubsNameIt: [
				Str.includes(`the ${agent.pluginName}:${agent.name} subagent`)(stubsFor.claude),
				Str.includes(`the ${agent.name} subagent`)(stubsFor.codex),
			],
		},
		{
			describedWithoutLine: true,
			internalIds: true,
			model: pinnedModel,
			opensWithLine: true,
			readsAgain: true,
			roleInstructions: true,
			stubsNameIt: [true, true],
		},
	);
});

it.layer(NodeServices.layer)("the plugin's pinned subagent", (test) => {
	test.effect(
		"runs on phi/sealed, opens its instructions with the pinned line, rereads its sources and answers with internal ids, and the Codex role carries the same instructions, and the Claude Code and Codex stubs name it",
		() => shipped,
	);
});
