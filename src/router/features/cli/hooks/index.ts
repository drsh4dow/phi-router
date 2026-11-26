import { Command, Flag } from "effect/cli";
import { Proofs, SessionRequests } from "#router/client/router-port/index.ts";
import { claude, modelAddress } from "#router/features/cli/adapters.ts";
import { TurnNotices } from "#router/client/turn-notices.ts";
import { answerCheck } from "./answer-check.ts";
import { promptSubmit } from "./prompt-submit.ts";
import { session } from "#router/features/cli/sessions/index.ts";
import { spelling } from "#shared/cli.ts";
import { statusline } from "./statusline.ts";
import { turnEnd } from "./turn-end.ts";

const hookCommands = [
	Command.make("prompt-submit", { address: modelAddress, claude }, (flags) => promptSubmit(flags)).pipe(
		Command.provide(SessionRequests.layer),
		Command.provide(Proofs.layer),
		Command.unlisted,
	),
	Command.make("turn-end", { address: modelAddress }, (flags) => turnEnd(flags)).pipe(
		Command.provide(SessionRequests.layer),
		Command.provide(TurnNotices.layer),
		Command.unlisted,
	),
	Command.make("answer-check", { address: modelAddress }, (flags) => answerCheck(flags)).pipe(
		Command.provide(SessionRequests.layer),
		Command.unlisted,
	),
	Command.make(
		spelling.statusline.name,
		{ address: modelAddress, session, words: Flag.String("words").pipe(Flag.withDefault("")) },
		(flags) => statusline(flags.words, flags.address, flags.session),
	).pipe(Command.provide(SessionRequests.layer), Command.provide(Proofs.layer), Command.unlisted),
] as const;

export { hookCommands };

export { rewriteExit } from "./answer-check.ts";

export { sessionStart } from "./session-start.ts";
