import { Command, Flag } from "effect/cli";
import { Console, Effect, Option } from "effect";
import { modelAddress, pid } from "./adapters.ts";
import { port, session } from "./sessions/index.ts";
import { Proofs } from "#router/client/router-port/index.ts";
import { serve } from "./serve.ts";
import { sessionStart } from "./hooks/index.ts";
import { spelling } from "#shared/cli.ts";
import { start } from "./start.ts";

const folder = Flag.String(spelling.start.folder);

const claude = Flag.Boolean("claude").pipe(Flag.withDefault(false));

const routerCommands = [
	Command.make(spelling.start.name, { folder, pid, port, session }, (flags) =>
		start({ folder: flags.folder, pid: flags.pid, session: flags.session }, flags.port, "pi").pipe(
			Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Console.log })),
		),
	).pipe(Command.provide(Proofs.layer)),
	Command.make("session-start", { address: modelAddress, claude, pid }, (flags) => sessionStart(flags)).pipe(
		Command.unlisted,
		Command.provide(Proofs.layer),
	),
	Command.make("serve", { port }, (flags) => serve(flags.port)).pipe(Command.unlisted, Command.provide(Proofs.layer)),
] as const;

export { routerCommands };
