import { Command, Flag } from "effect/cli";
import { address, pid } from "./adapters.ts";
import { port, session } from "./sessions.ts";
import { Proofs } from "#router/client/router-port/index.ts";
import { serve } from "./serve.ts";
import { sessionStart } from "./session-start.ts";
import { spelling } from "#shared/cli.ts";
import { start } from "./start.ts";

const folder = Flag.String(spelling.start.folder);

/** The hook is Claude Code's, so `session-start` also checks that the session's settings keep it on the router. */
const claude = Flag.Boolean("claude").pipe(Flag.withDefault(false));

/**
 * The commands that need the router's proof: `start`, which leaves pi's lease and starts a router when none runs, the
 * hooks' `session-start`, which does the same for a harness, and `serve`, the router itself. The last two are unlisted.
 */
const routerCommands = [
	Command.make(spelling.start.name, { folder, pid, port, session }, (flags) =>
		start({ folder: flags.folder, pid: flags.pid, session: flags.session }, flags.port, "pi"),
	).pipe(Command.provide(Proofs.layer)),
	Command.make("session-start", { address, claude, pid }, (flags) => sessionStart(flags)).pipe(
		Command.unlisted,
		Command.provide(Proofs.layer),
	),
	Command.make("serve", { port }, (flags) => serve(flags.port)).pipe(Command.unlisted, Command.provide(Proofs.layer)),
] as const;

export { routerCommands };
