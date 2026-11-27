import { Config, Effect, Option, Path } from "effect";

const windowsSeparator = "\\";

const onWindows: Effect.Effect<boolean> = Effect.serviceOption(Path.Path).pipe(
	Effect.map(Option.exists(({ sep }) => sep === windowsSeparator)),
);

const forPlatform = <Choice>(choices: { readonly posix: Choice; readonly windows: Choice }): Effect.Effect<Choice> =>
	onWindows.pipe(
		Effect.map((windows) => {
			if (windows) {
				return choices.windows;
			}

			return choices.posix;
		}),
	);

const homeFolder: Effect.Effect<string, Config.ConfigError> = forPlatform({
	posix: Config.String("HOME"),
	windows: Config.String("HOME").pipe(Config.orElse(() => Config.String("USERPROFILE"))),
}).pipe(Effect.flatten);

export { forPlatform, homeFolder };
