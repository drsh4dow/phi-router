import { Array, Effect, Predicate, String as Str, pipe } from "effect";
import type { CleanLaneRefused, CodexRequest, CodexRequestRejected } from "./index.ts";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import type { Lookup } from "#router/features/verdicts/index.ts";
import type { ToolsNotCleared } from "#router/features/border/index.ts";
import { decodeRequest } from "./index.ts";
import { guard } from "#router/features/border/index.ts";
import { partsOf } from "#router/features/parts/index.ts";
import { requests } from "./captures/index.ts";

const realModel = "gpt-5.5";

const nothingWritten = (): boolean => false;

/**
 * The clean lane's body as the route builds it: the border's messages under `lookup`, then the codec.
 *
 * @param {CodexRequest} request The request.
 * @param {Lookup} lookup What the border knows of each key.
 * @returns {Effect.Effect<string, CleanLaneRefused | ToolsNotCleared, Digest.Digest>} The body.
 */
const cleanOf = (
	request: Pick<CodexRequest, "encode" | "messages">,
	lookup: Lookup,
): Effect.Effect<string, CleanLaneRefused | ToolsNotCleared, Digest.Digest> =>
	Effect.flatMap(guard({ harness: "codex", lookup, messages: request.messages }), (messages) =>
		request.encode({ lane: "clean", messages, model: realModel }),
	);

const withFormat = (description: string): ((text: string) => string) =>
	Str.replace(
		'"text":{"verbosity":"low"}',
		`"text":{"verbosity":"low","format":{"type":"json_schema","strict":true,"schema":{"type":"object","description":"${description}"},"name":"codex_output_schema"}}`,
	);

const clearing = (text: string): Effect.Effect<Lookup, CodexRequestRejected, Digest.Digest> =>
	Effect.gen(function* clearAll() {
		const request = yield* decodeRequest(text, nothingWritten);
		const parts = yield* Effect.forEach(request.messages, partsOf, { concurrency: 1 });

		const keys = new Set(
			pipe(
				parts,
				Array.flatten,
				Array.map(({ key }) => key),
			),
		);

		return (key) => {
			if (keys.has(key)) {
				return "cleared";
			}

			return "sealed";
		};
	});

const changeRefused = ([text, changed]: readonly [string, string]): Effect.Effect<
	void,
	CodexRequestRejected | CleanLaneRefused | ToolsNotCleared | string,
	Digest.Digest
> =>
	Effect.gen(function* refuseChange() {
		const lookup = yield* clearing(text);
		const request = yield* decodeRequest(text, nothingWritten);
		const changedRequest = yield* decodeRequest(changed, nothingWritten);
		const error = yield* Effect.flip(cleanOf(changedRequest, lookup));

		yield* cleanOf(request, lookup);

		assert.notStrictEqual(changed, text);
		assert.isTrue(Predicate.isTagged(error, "ToolsNotCleared"));
	});

const changes = [
	[
		"a call name",
		requests.functionCall,
		Str.replace('"name":"exec_command","arguments"', '"name":"chart_4471","arguments"')(requests.functionCall),
	],
	[
		"custom tool call name",
		requests.customToolCall,
		Str.replace('0771","name":"exec"', '0771","name":"chart_4471"')(requests.customToolCall),
	],
	[
		"a call namespace",
		requests.subagentParent,
		Str.replace('"namespace":"collaboration"', '"namespace":"chart_4471"')(requests.subagentParent),
	],
	[
		"an agent message's author",
		requests.subagentParent,
		Str.replace('"author":"/root/notes_first_word"', '"author":"/root/chart_4471"')(requests.subagentParent),
	],
	[
		"an agent message's recipient",
		requests.subagent,
		Str.replace('"recipient":"/root/notes_first_word"', '"recipient":"/root/chart_4471"')(requests.subagent),
	],
	[
		"the agent name in the turn metadata",
		requests.firstTurn,
		Str.replace(
			String.raw`agent_name\":\"/root\"`,
			String.raw`agent_name\":\"/root/chart_4471\"`,
		)(requests.firstTurn),
	],
	[
		"subagent kind",
		requests.subagent,
		Str.replace('"x-openai-subagent":"collab_spawn"', '"x-openai-subagent":"chart_smith"')(requests.subagent),
	],
	[
		"the reply's output schema",
		withFormat("a title")(requests.firstTurn),
		withFormat("chart 4471")(requests.firstTurn),
	],
] as const;

it.layer(Digest.layerWebCrypto)("what the clean lane gets unchanged", (test) => {
	test.effect.each(changes)("a new %s refuses the clean lane until cleared", ([, text, changed]) =>
		changeRefused([text, changed]),
	);
});
