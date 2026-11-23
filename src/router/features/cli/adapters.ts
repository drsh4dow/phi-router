import { Command, Flag } from "effect/cli";
import { Pid, spelling } from "#shared/cli.ts";
import { offCodex, onCodex } from "./codex.ts";
import { codexPrompt } from "./codex-prompt.ts";
import { doctor } from "./doctor.ts";
import { doctorCodex } from "./doctor-codex.ts";
import { doctorPi } from "./doctor-pi.ts";
import { off } from "./off.ts";
import { on } from "./on.ts";

/** The model address a hook read from its harness. An empty value means none. */
const address = Flag.String("address");

const pid = Flag.Int(spelling.start.pid).pipe(Flag.withSchema(Pid));

/** Claude Code's config folder, when it is not the one `CLAUDE_CONFIG_DIR` or the home folder gives. Empty means none. */
const configDir = Flag.String("config-dir").pipe(Flag.withDefault(""));

const claudeOn = Command.make("claude", { configDir }, (flags) => on(flags.configDir));

const claudeOff = Command.make("claude", { configDir }, (flags) => off(flags.configDir));

const claudeDoctor = Command.make("claude", { configDir }, (flags) => doctor(flags.configDir));

/** Codex's home folder, when it is not the one `CODEX_HOME` or the home folder gives. Empty means none. */
const codexHome = Flag.String("codex-home").pipe(Flag.withDefault(""));

const codexOn = Command.make("codex", { codexHome }, (flags) => onCodex(flags.codexHome));

const codexOff = Command.make("codex", { codexHome }, (flags) => offCodex(flags.codexHome));

const codexDoctor = Command.make("codex", { codexHome }, (flags) => doctorCodex(flags.codexHome));

/** The agent folder of pi, when it is not the one `PI_CODING_AGENT_DIR` or the home folder gives. Empty means none. */
const agentDir = Flag.String("agent-dir").pipe(Flag.withDefault(""));

const piDoctor = Command.make("pi", { agentDir }, (flags) => doctorPi(flags.agentDir));

/**
 * The commands of the harness adapters: the hook's `codex-prompt`, and `on`, `off` and `doctor`
 * with one subcommand per harness and its own flags. A harness adds its subcommand to each group.
 */
const adapterCommands = [
	Command.make("codex-prompt", {}, () => codexPrompt()).pipe(Command.unlisted),
	Command.make("on").pipe(Command.withSubcommands([claudeOn, codexOn])),
	Command.make("off").pipe(Command.withSubcommands([claudeOff, codexOff])),
	Command.make("doctor").pipe(Command.withSubcommands([claudeDoctor, codexDoctor, piDoctor])),
] as const;

export { address, adapterCommands, pid };
