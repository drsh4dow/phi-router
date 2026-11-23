import { Console, Effect } from "effect";
import { Command } from "effect/cli";
import { Platform } from "./platform.ts";
import { accounts } from "./accounts.ts";
import { adapterCommands } from "./adapters.ts";
import { hookCommands } from "./hooks.ts";
import { routerCommands } from "./router-commands.ts";
import { sessionCommands } from "./sessions.ts";
import { spelling } from "#shared/cli.ts";

const root = Command.make(
	spelling.program,
	{},
	Effect.fn("phi-router")(function* root() {
		const platform = yield* Platform;

		yield* Console.log(`phi-router runs on the ${platform.name} platform layer`);
	}),
);

/** The argv surface. A new command is one file beside this one and one entry in this list. */
const cli = root.pipe(
	Command.withSubcommands([...sessionCommands, ...routerCommands, ...hookCommands, ...adapterCommands, accounts]),
	Command.run({ version: "0.0.0" }),
);

export { cli };

export { Platform } from "./platform.ts";

export { roleFile, sealedRole } from "./codex-settings.ts";
