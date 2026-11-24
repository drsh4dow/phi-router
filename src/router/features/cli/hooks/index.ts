import { Command } from "effect/cli";
import { Layer } from "effect";
import { SealNotices } from "#router/client/seal-notices.ts";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { modelAddress } from "#router/features/cli/adapters.ts";
import { promptSubmit } from "./prompt-submit.ts";
import { turnEnd } from "./turn-end.ts";

/**
 * The `/phi` commands of the Claude Code and Codex plugins' hooks, unlisted: `prompt-submit` answers `/phi`, and
 * `turn-end` announces a turn that sealed.
 */
const hookCommands = [
	Command.make("prompt-submit", { address: modelAddress }, (flags) => promptSubmit(flags)).pipe(
		Command.provide(SessionRequests.layer),
		Command.unlisted,
	),
	Command.make("turn-end", { address: modelAddress }, (flags) => turnEnd(flags)).pipe(
		Command.provide(Layer.merge(SessionRequests.layer, SealNotices.layer)),
		Command.unlisted,
	),
] as const;

export { hookCommands };

export { sessionStart } from "./session-start.ts";
