import { Array, pipe } from "effect";
import { Command, Flag } from "effect/cli";
import { SessionId, productPort, spelling } from "#shared/cli.ts";
import { pin, unpin } from "./pin.ts";
import { SessionRequests } from "#router/client/session-request.ts";
import { status } from "./status.ts";

const session = Flag.String(spelling.status.session).pipe(Flag.withSchema(SessionId));

const port = Flag.Int(spelling.start.port).pipe(Flag.withDefault(productPort));

const asked = { port, session };

/** The commands that ask the running router about a session. */
const sessionCommands = pipe(
	[
		Command.make(spelling.status.name, asked, (flags) => status(flags.session, flags.port)),
		Command.make(spelling.pin.name, asked, (flags) => pin(flags.session, flags.port)),
		Command.make(spelling.unpin.name, asked, (flags) => unpin(flags.session, flags.port)),
	],
	Array.map(Command.provide(SessionRequests.layer)),
);

export { port, session, sessionCommands };
