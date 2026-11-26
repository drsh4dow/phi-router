import { Command, Flag } from "effect/cli";
import { Pid, spelling } from "#shared/cli.ts";
import { codexPrompt, offCodex, onCodex } from "./codex/index.ts";
import { doctorClaude, doctorCodex, doctorPi } from "./doctor/index.ts";
import { off, on } from "./claude/index.ts";
import { Proofs } from "#router/client/router-port/index.ts";
import { setupCommand } from "./setup/index.ts";

const modelAddress = Flag.String("address");

const claude = Flag.Boolean("claude").pipe(Flag.withDefault(false));

const pid = Flag.Int(spelling.start.pid).pipe(Flag.withSchema(Pid));

const configDir = Flag.String("config-dir").pipe(Flag.withDefault(""));

const claudeOn = Command.make("claude", { configDir }, (flags) => on(flags.configDir));

const claudeOff = Command.make("claude", { configDir }, (flags) => off(flags.configDir));

const claudeDoctor = Command.make("claude", { configDir }, (flags) => doctorClaude(flags.configDir));

const codexHome = Flag.String("codex-home").pipe(Flag.withDefault(""));

const codexOn = Command.make("codex", { codexHome }, (flags) => onCodex(flags.codexHome));

const codexOff = Command.make("codex", { codexHome }, (flags) => offCodex(flags.codexHome));

const codexDoctor = Command.make("codex", { codexHome }, (flags) => doctorCodex(flags.codexHome));

const agentDir = Flag.String("agent-dir").pipe(Flag.withDefault(""));

const piDoctor = Command.make("pi", { agentDir }, (flags) => doctorPi(flags.agentDir));

const adapterCommands = [
	Command.make("codex-prompt", {}, () => codexPrompt()).pipe(Command.unlisted),
	Command.make("on").pipe(Command.withSubcommands([claudeOn, codexOn])),
	Command.make("off").pipe(Command.withSubcommands([claudeOff, codexOff])),
	Command.make("doctor").pipe(Command.withSubcommands([claudeDoctor, codexDoctor, piDoctor])),
	setupCommand.pipe(Command.provide(Proofs.layer)),
] as const;

export { adapterCommands, claude, modelAddress, pid };
