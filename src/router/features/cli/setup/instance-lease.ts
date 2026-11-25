import { Config, Effect, Path, String as Str } from "effect";
import { productPort } from "#shared/cli.ts";
import { start } from "#router/features/cli/start.ts";

const none = 0;

const callerOf = Config.all({
	pid: Config.Int("CLAUDE_PID").pipe(Config.withDefault(none)),
	session: Config.String("CLAUDE_CODE_SESSION_ID").pipe(Config.withDefault("")),
});

const claudeInstanceLeased = Effect.gen(function* claudeInstanceLeased() {
	const { pid, session } = yield* callerOf;

	if (pid <= none || Str.isEmpty(session)) {
		return;
	}

	const path = yield* Path.Path;

	yield* start({ folder: path.resolve("."), pid, session }, productPort, "claude");
});

export { claudeInstanceLeased };
