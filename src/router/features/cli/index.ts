import { Console, Effect } from "effect";
import { Command } from "effect/cli";
import { Platform } from "./platform.ts";
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

const cli = root.pipe(
	Command.withSubcommands([
		...sessionCommands,
		...routerCommands,
		...hookCommands,
		...adapterCommands,
		accounts,
		models,
	]),
	Command.run({ version: "0.0.0" }),
);

export { cli };

export { Platform } from "./platform.ts";

export { noBaaKeyExit } from "./no-baa-key.ts";

export { pinnedRoleFile, sealedRole } from "./codex/index.ts";
