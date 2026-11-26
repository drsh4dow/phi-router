import { Context, Effect, FileSystem, Layer, Option, Path, Schema, String as Str } from "effect";

const SubagentMeta = Schema.fromJsonString(Schema.Struct({ agentType: Schema.String }));

interface SubagentRun {
	readonly transcript: string;
	readonly subagent: string;
}

class ClaudeSubagents extends Context.Service<
	ClaudeSubagents,
	{ readonly typeOf: (run: SubagentRun) => Effect.Effect<Option.Option<string>> }
>()("phi-router/router/client/harnesses/claude-subagents/ClaudeSubagents") {
	public static readonly layer = Layer.effect(
		ClaudeSubagents,
		Effect.gen(function* make() {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			return ClaudeSubagents.of({
				typeOf: (run) => {
					const session = Str.replace(/\.jsonl$/u, "")(run.transcript);

					return fs.readFileString(path.join(session, "subagents", `agent-${run.subagent}.meta.json`)).pipe(
						Effect.flatMap(Schema.decodeEffect(SubagentMeta)),
						Effect.map(({ agentType }) => Option.some(agentType)),
						Effect.orElseSucceed(() => Option.none<string>()),
					);
				},
			});
		}),
	);
}

export { ClaudeSubagents };
