import { Config, Effect, Path } from "effect";

const windowsSeparator = "\\";

const defaultSystemRoot = String.raw`C:\Windows`;

const forPlatform = <Choice>(choices: {
	readonly posix: Choice;
	readonly windows: Choice;
}): Effect.Effect<Choice, never, Path.Path> =>
	Effect.map(Effect.service(Path.Path), ({ sep }) => {
		if (sep === windowsSeparator) {
			return choices.windows;
		}

		return choices.posix;
	});

const homeFolder: Effect.Effect<string, Config.ConfigError, Path.Path> = forPlatform({
	posix: Config.String("HOME"),
	windows: Config.String("HOME").pipe(Config.orElse(() => Config.String("USERPROFILE"))),
}).pipe(Effect.flatten);

const systemTool = Effect.fnUntraced(function* systemTool(...names: readonly string[]) {
	const path = yield* Path.Path;

	const root = yield* Config.String("SystemRoot").pipe(
		Config.withDefault(defaultSystemRoot),
		Effect.orElseSucceed(() => defaultSystemRoot),
	);

	return path.join(root, "System32", ...names);
});

export { forPlatform, homeFolder, systemTool };
