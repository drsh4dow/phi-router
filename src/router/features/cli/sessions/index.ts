import { Command, Flag } from "effect/cli";
import { SessionId, productPort, spelling } from "#shared/cli.ts";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { answerCheck } from "./answer-check.ts";
import { status } from "./status.ts";

const session = Flag.String(spelling.status.session).pipe(Flag.withSchema(SessionId));

const port = Flag.Int(spelling.start.port).pipe(Flag.withDefault(productPort));

const sessionCommands = [
	Command.make(spelling.status.name, { port, session }, (flags) => status(flags.session, flags.port)).pipe(
		Command.provide(SessionRequests.layer),
	),
	Command.make(spelling.answerCheck.name, { port }, (flags) => answerCheck(flags.port)).pipe(
		Command.unlisted,
		Command.provide(SessionRequests.layer),
	),
];

export { port, session, sessionCommands };

export { failedAs } from "./status.ts";
