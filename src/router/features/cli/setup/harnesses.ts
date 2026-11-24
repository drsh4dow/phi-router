import { Effect, Option, Path } from "effect";
import { claudeCanary, codexCanary, piCanary } from "#router/features/cli/doctor/index.ts";
import { claudePlugin, codexHome, codexPlugin, installedPackage } from "#router/client/harnesses/index.ts";
import { pluginId, switchedOn } from "#router/features/cli/claude/index.ts";
import type { Check } from "#router/features/cli/doctor/index.ts";
import type { Harness } from "#router/features/border/index.ts";
import type { Vendor } from "#router/client/configuration/index.ts";
import { codexSwitchedOn } from "#router/features/cli/codex/index.ts";

interface InstallSource {
	readonly claudeMarketplace: string;
	readonly codexMarketplaceArgs: readonly string[];
	readonly piPackage: string;
}

type Argv = readonly [string, ...string[]];

interface HarnessSetup {
	readonly baaVendor: Vendor;
	readonly canary: (packageRoot: string) => Effect.Effect<readonly Check[], unknown, unknown>;
	readonly closingLines: (source: InstallSource) => readonly string[];
	readonly installCommands: (source: InstallSource) => readonly Argv[];
	readonly installed: Effect.Effect<Option.Option<unknown>, unknown, unknown>;
	readonly start: Argv;
	readonly subscription: string;
	readonly switchOn: Effect.Effect<Option.Option<string>, Error, unknown>;
	readonly title: string;
}

const pluginFolderIn = Effect.fnUntraced(function* pluginFolderIn(packageRoot: string) {
	const path = yield* Path.Path;

	return path.join(packageRoot, "plugins", "claude");
});

/**
 * What setup does in each harness: its name and the subscription it logs in to, as the human reads them, the vendor of
 * its BAA account, the installer's commands, where the install landed, the canary test through the phi-router package
 * setup runs from, before anything is installed, the harness's own settings, written last with the line that says so,
 * and how setup starts it and ends its screen. pi writes no settings, since its package is its whole switch.
 */
const harnesses = {
	claude: {
		baaVendor: "anthropic",
		canary: (packageRoot: string) => Effect.flatMap(pluginFolderIn(packageRoot), claudeCanary),
		closingLines: (): readonly string[] => [
			"Done. Claude Code windows that were already open, including the one you",
			"started from, stop answering. Close them.",
			"Undo any time with: npx phi-router off claude",
			"",
			"Press Enter to start Claude Code with phi-router.",
		],
		installCommands: (source: InstallSource): readonly Argv[] => [
			["claude", "plugin", "install", "phi-router", "--marketplace", source.claudeMarketplace, "--scope", "user"],
		],
		installed: claudePlugin("", pluginId),
		start: ["claude"] satisfies Argv,
		subscription: "Claude",
		switchOn: Effect.as(switchedOn(""), Option.some("Claude Code now sends its requests through phi-router")),
		title: "Claude Code",
	},
	codex: {
		baaVendor: "openai",
		canary: Effect.fnUntraced(function* codexCanaryIn(packageRoot: string) {
			const folder = yield* pluginFolderIn(packageRoot);

			return yield* codexCanary({ folder, place: "plugins/cache/phi-router/phi-router/setup", trust: "" });
		}),
		closingLines: (): readonly string[] => [
			"Done. Close any Codex window that was already open, and use the one setup starts.",
			"Undo any time with: npx phi-router off codex",
			"",
			"Press Enter to start Codex. It asks once to review phi-router's hooks.",
			'Pick "Trust all and continue". Until you do, prompts fail and nothing is sent.',
		],
		installCommands: (source: InstallSource): readonly Argv[] => [
			["codex", "plugin", "marketplace", "add", ...source.codexMarketplaceArgs],
			["codex", "plugin", "add", pluginId],
		],
		installed: Effect.gen(function* codexInstalled() {
			const path = yield* Path.Path;
			const home = yield* codexHome("");

			return yield* codexPlugin(path.join(home, "plugins", "cache", "phi-router", "phi-router"));
		}),
		start: ["codex"] satisfies Argv,
		subscription: "ChatGPT",
		switchOn: Effect.as(codexSwitchedOn(""), Option.some("Codex now sends its requests through phi-router")),
		title: "Codex",
	},
	pi: {
		baaVendor: "anthropic",
		canary: piCanary,
		closingLines: (source: InstallSource): readonly string[] => [
			"Done. Close any pi window that was already open, and use the one setup starts.",
			`Undo any time with: pi remove ${source.piPackage}`,
			"",
			"Press Enter to start pi on phi/auto. Only phi/auto is protected. Other models in /model skip phi-router.",
		],
		installCommands: (source: InstallSource): readonly Argv[] => [["pi", "install", source.piPackage]],
		installed: Effect.map(
			installedPackage(""),
			Option.map(({ folder }) => folder),
		),
		start: ["pi", "--model", "phi/auto"] satisfies Argv,
		subscription: "Claude",
		switchOn: Effect.succeed(Option.none<string>()),
		title: "pi",
	},
} as const satisfies Record<Harness, HarnessSetup>;

type HarnessName = keyof typeof harnesses;

export { harnesses };

export type { HarnessName, InstallSource };
