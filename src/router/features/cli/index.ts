import { Console, Effect, Option } from "effect";
import { Platform, ownVersion } from "./platform.ts";
import { Command } from "effect/cli";
import { accounts } from "./accounts/index.ts";
import { adapterCommands } from "./adapters.ts";
import { hookCommands } from "./hooks/index.ts";
import { models } from "./models.ts";
import { routerCommands } from "./router-commands.ts";
import { sessionCommands } from "./sessions/index.ts";
import { spelling } from "#shared/cli.ts";

const root = Command.make(
	spelling.program,
	{},
	Effect.fn("phi-router")(function* root() {
		const platform = yield* Platform;

		yield* Console.log(`phi-router runs on the ${platform.name} platform layer`);
	}),
);

const commands = root.pipe(
	Command.withSubcommands([
		...sessionCommands,
		...routerCommands,
		...hookCommands,
		...adapterCommands,
		accounts,
		models,
	]),
);

const unknownVersion = "unknown";

const cli = Effect.gen(function* cli() {
	const version = yield* Effect.option(ownVersion);

	return yield* Command.run(commands, { version: Option.getOrElse(version, () => unknownVersion) });
});

export { cli };

export { Platform } from "./platform.ts";

export { noBaaKeyExit } from "./no-baa-key.ts";

export { start } from "./start.ts";

export { rewriteExit } from "./hooks/index.ts";

export { pinnedRoleFile, sealedRole } from "./codex/index.ts";
