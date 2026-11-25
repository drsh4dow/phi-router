import { Effect, Option, Path } from "effect";
import { claudeCanary, codexCanary, piCanary } from "#router/features/cli/doctor/index.ts";
import {
	claudePlugin,
	claudeSignIn,
	codexHome,
	codexPlugin,
	codexSignIn,
	installedPackage,
	piSignIn,
} from "#router/client/harnesses/index.ts";
import { pluginId, switchedOn } from "#router/features/cli/claude/index.ts";
import type { Check } from "#router/features/cli/doctor/index.ts";
import type { Harness } from "#router/features/border/index.ts";
import type { SignIn } from "#router/client/harnesses/index.ts";
import type { Vendor } from "#router/client/configuration/index.ts";
import { claudeInstanceLeased } from "./instance-lease.ts";
import { codexSwitchedOn } from "#router/features/cli/codex/index.ts";

interface InstallSource {
	readonly claudeMarketplace: string;
	readonly codexMarketplaceArgs: readonly string[];
	readonly piPackage: string;
}

type Argv = readonly [string, ...string[]];

interface HarnessSetup {
	readonly vendor: Vendor;
	readonly canary: (packageRoot: string) => Effect.Effect<readonly Check[], unknown, unknown>;
	readonly closingLines: (source: InstallSource) => readonly string[];
	readonly installCommands: (source: InstallSource) => readonly Argv[];
	readonly installed: Effect.Effect<Option.Option<unknown>, unknown, unknown>;
	readonly signIn: Effect.Effect<SignIn, unknown, unknown>;
	readonly signInHow: string;
	readonly start: Argv;
	readonly switchOn: Effect.Effect<Option.Option<string>, Error, unknown>;
	readonly title: string;
}

const pluginFolderIn = Effect.fnUntraced(function* pluginFolderIn(packageRoot: string) {
	const path = yield* Path.Path;

	return path.join(packageRoot, "plugins", "claude");
});

const harnesses = {
	claude: {
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
		signIn: claudeSignIn(""),
		signInHow: "/login",
		start: ["claude"] satisfies Argv,
		switchOn: Effect.andThen(
			claudeInstanceLeased,
			Effect.as(switchedOn(""), Option.some("Claude Code now sends its requests through phi-router")),
		),
		title: "Claude Code",
		vendor: "anthropic",
	},
	codex: {
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
		signIn: codexSignIn,
		signInHow: "codex login",
		start: ["codex"] satisfies Argv,
		switchOn: Effect.as(codexSwitchedOn(""), Option.some("Codex now sends its requests through phi-router")),
		title: "Codex",
		vendor: "openai",
	},
	pi: {
		canary: piCanary,
		closingLines: (source: InstallSource): readonly string[] => [
			"Done. Close any pi window that was already open, and use the one setup starts.",
			`Undo any time with: pi remove ${source.piPackage}`,
			"",
			"Press Enter to start pi on phi/auto. Models outside phi skip phi-router.",
		],
		installCommands: (source: InstallSource): readonly Argv[] => [["pi", "install", source.piPackage]],
		installed: Effect.map(
			installedPackage(""),
			Option.map(({ folder }) => folder),
		),
		signIn: piSignIn,
		signInHow: "/login",
		start: ["pi", "--model", "phi/auto"] satisfies Argv,
		switchOn: Effect.succeed(Option.none<string>()),
		title: "pi",
		vendor: "anthropic",
	},
} as const satisfies Record<Harness, HarnessSetup>;

type HarnessName = keyof typeof harnesses;

export { harnesses };

export type { HarnessName, InstallSource };
