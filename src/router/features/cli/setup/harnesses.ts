import { Effect, Option, Path } from "effect";
import { claudeCanary, codexCanary, piCanary } from "#router/features/cli/doctor/index.ts";
import { claudePlugin, codexHome, codexPlugin, installedPackage } from "#router/client/harnesses/index.ts";
import { plugin, switchedOn } from "#router/features/cli/claude/index.ts";
import type { Check } from "#router/features/cli/doctor/index.ts";
import type { Harness } from "#router/features/border/index.ts";
import type { Vendor } from "#router/client/configuration/index.ts";
import { codexSwitchedOn } from "#router/features/cli/codex/index.ts";

/**
 * Where setup installs phi-router from, as each installer takes it: Claude Code's marketplace, what
 * `codex plugin marketplace add` takes, and pi's package.
 */
interface Source {
	readonly claude: string;
	readonly codex: readonly string[];
	readonly pi: string;
}

/** One command line: the program and its arguments. */
type Argv = readonly [string, ...string[]];

interface HarnessSetup {
	readonly end: (source: Source) => readonly string[];
	readonly install: (source: Source) => readonly Argv[];
	readonly installed: Effect.Effect<Option.Option<unknown>, unknown, unknown>;
	readonly start: Argv;
	readonly subscription: string;
	readonly switched: Effect.Effect<Option.Option<string>, Error, unknown>;
	readonly test: (root: string) => Effect.Effect<readonly Check[], unknown, unknown>;
	readonly title: string;
	readonly vendor: Vendor;
}

/** The Claude Code and Codex plugin in the phi-router package at `root`. */
const pluginIn = Effect.fnUntraced(function* pluginIn(root: string) {
	const path = yield* Path.Path;

	return path.join(root, "plugins", "claude");
});

/**
 * What setup does in each harness: its name and the subscription it logs in to, as the human reads them, the vendor of
 * its BAA account, the installer's commands, where the install landed, the canary test through the phi-router package
 * setup runs from, before anything is installed, the harness's own settings, written last with the line that says so,
 * and how setup starts it and ends its screen. pi writes no settings, since its package is its whole switch.
 */
const harnesses = {
	claude: {
		end: (): readonly string[] => [
			"Done. Claude Code windows that were already open, including the one you",
			"started from, stop answering. Close them.",
			"Undo any time with: npx phi-router off claude",
			"",
			"Press Enter to start Claude Code with phi-router.",
		],
		install: (source: Source): readonly Argv[] => [
			["claude", "plugin", "install", "phi-router", "--marketplace", source.claude, "--scope", "user"],
		],
		installed: claudePlugin("", plugin),
		start: ["claude"] satisfies Argv,
		subscription: "Claude",
		switched: Effect.as(switchedOn(""), Option.some("Claude Code now sends its requests through phi-router")),
		test: (root: string) => Effect.flatMap(pluginIn(root), claudeCanary),
		title: "Claude Code",
		vendor: "anthropic",
	},
	codex: {
		end: (): readonly string[] => [
			"Done. Close any Codex window that was already open, and use the one setup starts.",
			"Undo any time with: npx phi-router off codex",
			"",
			"Press Enter to start Codex. It asks once to review phi-router's hooks.",
			'Pick "Trust all and continue". Until you do, prompts fail and nothing is sent.',
		],
		install: (source: Source): readonly Argv[] => [
			["codex", "plugin", "marketplace", "add", ...source.codex],
			["codex", "plugin", "add", plugin],
		],
		installed: Effect.gen(function* codexInstalled() {
			const path = yield* Path.Path;
			const home = yield* codexHome("");

			return yield* codexPlugin(path.join(home, "plugins", "cache", "phi-router", "phi-router"));
		}),
		start: ["codex"] satisfies Argv,
		subscription: "ChatGPT",
		switched: Effect.as(codexSwitchedOn(""), Option.some("Codex now sends its requests through phi-router")),
		test: Effect.fnUntraced(function* codexTest(root: string) {
			const folder = yield* pluginIn(root);

			return yield* codexCanary({ folder, place: "plugins/cache/phi-router/phi-router/setup", trust: "" });
		}),
		title: "Codex",
		vendor: "openai",
	},
	pi: {
		end: (source: Source): readonly string[] => [
			"Done. Close any pi window that was already open, and use the one setup starts.",
			`Undo any time with: pi remove ${source.pi}`,
			"",
			"Press Enter to start pi on phi/auto. Only phi/auto is protected. Other models in /model skip phi-router.",
		],
		install: (source: Source): readonly Argv[] => [["pi", "install", source.pi]],
		installed: Effect.map(
			installedPackage(""),
			Option.map(({ folder }) => folder),
		),
		start: ["pi", "--model", "phi/auto"] satisfies Argv,
		subscription: "Claude",
		switched: Effect.succeed(Option.none<string>()),
		test: piCanary,
		title: "pi",
		vendor: "anthropic",
	},
} as const satisfies Record<Harness, HarnessSetup>;

type HarnessName = keyof typeof harnesses;

export { harnesses };

export type { HarnessName, Source };
