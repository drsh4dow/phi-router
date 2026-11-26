import { Command } from "effect/cli";
import { Layer } from "effect";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { TurnNotices } from "#router/client/turn-notices.ts";
import { modelAddress } from "#router/features/cli/adapters.ts";
import { promptSubmit } from "./prompt-submit.ts";
import { statusline } from "./statusline.ts";
import { turnEnd } from "./turn-end.ts";

const hookCommands = [
	Command.make("prompt-submit", { address: modelAddress }, (flags) => promptSubmit(flags)).pipe(
		Command.provide(SessionRequests.layer),
		Command.unlisted,
	),
	Command.make("turn-end", { address: modelAddress }, (flags) => turnEnd(flags)).pipe(
		Command.provide(Layer.merge(SessionRequests.layer, TurnNotices.layer)),
		Command.unlisted,
	),
	Command.make("statusline", {}, () => statusline()).pipe(Command.provide(SessionRequests.layer)),
] as const;

export { hookCommands };

export { sessionStart } from "./session-start.ts";
