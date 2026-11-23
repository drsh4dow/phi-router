import { Array, Effect, FileSystem, Option, Path, Schema, String as Str, pipe } from "effect";

const Manifest = Schema.fromJsonString(Schema.Struct({ name: Schema.String }));

const plugin = decodeURIComponent(new URL("../../plugins/claude", import.meta.url).pathname);

/** The plugin's pinned subagent: its agent file's front matter fields and body, and the plugin's name. */
const agentFile = Effect.gen(function* agentFile() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const text = yield* fs.readFileString(path.join(plugin, "agents", "phi-sealed.md"));
	const [, front = "", body = ""] = Str.split(text, "---\n");

	const fields = pipe(
		Str.split(Str.trimEnd(front), "\n"),
		Array.map((line) => {
			const [key, ...value] = Str.split(line, ": ");

			return [key, Array.join(value, ": ")] as const;
		}),
	);

	const field = (key: string): string =>
		pipe(
			Array.findFirst(fields, ([named]) => named === key),
			Option.map(([, value]) => value),
			Option.getOrElse(() => ""),
		);

	const manifest = yield* fs.readFileString(path.join(plugin, ".claude-plugin", "plugin.json"));
	const { name: pluginName } = yield* Schema.decodeEffect(Manifest)(manifest);

	return {
		body: Str.trimStart(body),
		description: field("description"),
		model: field("model"),
		name: field("name"),
		pluginName,
	};
});

export { agentFile };
