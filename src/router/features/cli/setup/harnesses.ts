import { Array, Config, Effect, Option, Path, Predicate, Schema, String as Str, pipe } from "effect";
import { claudeCanary, codexCanary, piCanary } from "#router/features/cli/doctor/index.ts";
import {
	claudeMarketplace,
	claudePlugin,
	claudeSignIn,
	codexHome,
	codexPlugin,
	codexSignIn,
	followedMarketplace,
	installedPackage,
	piSignIn,
	textOrEmpty,
} from "#router/client/harnesses/index.ts";
import { pluginId, switchedOn } from "#router/features/cli/claude/index.ts";
import type { Check } from "#router/features/cli/doctor/index.ts";
import type { Harness } from "#router/features/border/index.ts";
import type { SignIn } from "#router/client/harnesses/index.ts";
import type { Vendor } from "#router/client/configuration/index.ts";
import { codexSwitchedOn } from "#router/features/cli/codex/index.ts";
import { productPort } from "#shared/cli.ts";
import { start } from "#router/features/cli/start.ts";
import { statementsOf } from "#router/primitives/toml.ts";

interface Target {
	readonly channel: string;
	readonly version: string;
	readonly checkout?: string | undefined;
}

type Installed =
	| { readonly kind: "absent" }
	| { readonly kind: "channel" | "held" | "elsewhere"; readonly version: string };

type Argv = readonly [string, ...string[]];

type Step = Argv | Effect.Effect<void, unknown, unknown>;

type Move = "install" | "update" | "move";

interface HarnessSetup {
	readonly vendor: Vendor;
	readonly canary: (packageRoot: string) => Effect.Effect<readonly Check[], unknown, unknown>;
	readonly closingLines: (target: Target) => readonly string[];
	readonly installed: (target: Target) => Effect.Effect<Installed, unknown, unknown>;
	readonly steps: (target: Target) => Readonly<Record<Move, readonly Step[]>>;
	readonly signIn: Effect.Effect<SignIn, unknown, unknown>;
	readonly signInHow: string;
	readonly start: Argv;
	readonly switchOn: Effect.Effect<Option.Option<string>, Error, unknown>;
	readonly title: string;
}

const repository = "drsh4dow/phi-router";

const marketplace = "phi-router";

interface Source {
	readonly fromRepository: boolean;
	readonly onChannel: boolean;
	readonly version: string | undefined;
}

const kindOf = ({ fromRepository, onChannel }: Source): Exclude<Installed["kind"], "absent"> => {
	if (!fromRepository) {
		return "elsewhere";
	}

	return ({ false: "held", true: "channel" } as const)[`${onChannel}`];
};

const installedAs = (source: Source): Installed => {
	if (Predicate.isUndefined(source.version)) {
		return { kind: "absent" };
	}

	return { kind: kindOf(source), version: source.version };
};

const GithubSource = Schema.Struct({
	ref: Schema.optionalKey(Schema.String),
	repo: Schema.Literal(repository),
	source: Schema.Literal("github"),
});

const Fetched = Schema.Struct({ source: GithubSource });

const Followed = Schema.Struct({ autoUpdate: Schema.Literal(true), source: GithubSource });

const claudeInstalled = Effect.fnUntraced(function* claudeInstalled(target: Target) {
	const plugin = yield* claudePlugin("", pluginId);
	const { declared, fetched } = yield* claudeMarketplace("", marketplace);
	const fromRepository = pipe(fetched, Option.flatMap(Schema.decodeUnknownOption(Fetched)));
	const followed = pipe(declared, Option.flatMap(Schema.decodeUnknownOption(Followed)));

	const onChannel = (entry: { readonly source: typeof GithubSource.Type }): boolean =>
		entry.source.ref === target.channel;

	return installedAs({
		fromRepository: Option.isSome(fromRepository),
		onChannel: Option.exists(fromRepository, onChannel) && Option.exists(followed, onChannel),
		version: pipe(
			plugin,
			Option.filter(() => Option.isSome(fetched)),
			Option.map(({ version }) => version),
			Option.getOrUndefined,
		),
	});
});

const codexRepository = `"https://github.com/${repository}.git"`;

const codexInstalled = Effect.fnUntraced(function* codexInstalled(target: Target) {
	const path = yield* Path.Path;
	const home = yield* codexHome("");
	const plugin = yield* codexPlugin(path.join(home, "plugins", "cache", marketplace, "phi-router"));
	const config = yield* textOrEmpty(path.join(home, "config.toml"));

	const valueOf = (key: string): Option.Option<string> =>
		pipe(
			statementsOf(config),
			Array.findFirst(
				({ kind, path: at }) => kind === "pair" && Array.join(at, ".") === `marketplaces.${marketplace}.${key}`,
			),
			Option.map(({ value }) => value),
		);

	const added = valueOf("source");

	return installedAs({
		fromRepository: Option.exists(added, (value) => value === codexRepository),
		onChannel: Option.exists(valueOf("ref"), (ref) => ref === `"${target.channel}"`),
		version: pipe(
			plugin,
			Option.filter(() => Option.isSome(added)),
			Option.map((folder) => path.basename(folder)),
			Option.getOrUndefined,
		),
	});
});

const piChannel = "npm:phi-router";

const piInstalled = Effect.map(installedPackage(""), (found) =>
	installedAs({
		fromRepository: Option.exists(
			found,
			({ source }) => source === piChannel || Str.startsWith(`${piChannel}@`)(source),
		),
		onChannel: Option.exists(found, ({ source }) => source === piChannel),
		version: pipe(
			found,
			Option.map(({ version }) => version),
			Option.getOrUndefined,
		),
	}),
);

const piPackage = (target: Target): string => target.checkout ?? piChannel;

const pluginFolderIn = Effect.fnUntraced(function* pluginFolderIn(packageRoot: string) {
	const path = yield* Path.Path;

	return path.join(packageRoot, "plugins", "claude");
});

const none = 0;

const callerOf = Config.all({
	pid: Config.Int("CLAUDE_PID").pipe(Config.withDefault(none)),
	session: Config.String("CLAUDE_CODE_SESSION_ID").pipe(Config.withDefault("")),
});

const claudeInstanceLeased = Effect.gen(function* claudeInstanceLeased() {
	const { pid, session } = yield* callerOf;

	if (pid <= none || Str.isEmpty(session)) {
		return;
	}

	const path = yield* Path.Path;

	yield* start({ folder: path.resolve("."), pid, session }, productPort, "claude");
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
		installed: claudeInstalled,
		signIn: claudeSignIn(""),
		signInHow: "/login",
		start: ["claude"] satisfies Argv,
		steps: (target: Target) => {
			const source = target.checkout ?? `${repository}@${target.channel}`;

			const install: Argv = [
				"claude",
				"plugin",
				"install",
				"phi-router",
				"--marketplace",
				source,
				"--scope",
				"user",
			];

			const followed = followedMarketplace("", marketplace, { ref: target.channel, repo: repository });
			const refreshed: Argv = ["claude", "plugin", "marketplace", "update", marketplace];
			const updated: Argv = ["claude", "plugin", "update", pluginId, "--scope", "user"];

			return {
				install: Option.match(Option.fromUndefinedOr(target.checkout), {
					onNone: () => [install, followed],
					onSome: () => [install],
				}),
				move: [followed, refreshed, updated],
				update: [refreshed, updated],
			};
		},
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
		installed: codexInstalled,
		signIn: codexSignIn,
		signInHow: "codex login",
		start: ["codex"] satisfies Argv,
		steps: (target: Target) => {
			const source = Option.match(Option.fromUndefinedOr(target.checkout), {
				onNone: () => [repository, "--ref", target.channel],
				onSome: (folder) => [folder],
			});

			const add: Argv = ["codex", "plugin", "add", pluginId];
			const install: readonly Argv[] = [["codex", "plugin", "marketplace", "add", ...source], add];

			return {
				install,
				move: [["codex", "plugin", "marketplace", "remove", marketplace], ...install],
				update: [["codex", "plugin", "marketplace", "upgrade", marketplace], add],
			};
		},
		switchOn: Effect.as(codexSwitchedOn(""), Option.some("Codex now sends its requests through phi-router")),
		title: "Codex",
		vendor: "openai",
	},
	pi: {
		canary: piCanary,
		closingLines: (target: Target): readonly string[] => [
			"Done. Close any pi window that was already open, and use the one setup starts.",
			`Undo any time with: pi remove ${piPackage(target)}`,
			"",
			"Press Enter to start pi on phi/auto. Models outside phi skip phi-router.",
		],
		installed: () => piInstalled,
		signIn: piSignIn,
		signInHow: "/login",
		start: ["pi", "--model", "phi/auto"] satisfies Argv,
		steps: (target: Target) => {
			const install: readonly Argv[] = [["pi", "install", piPackage(target)]];
			const update: readonly Argv[] = [["pi", "update", piPackage(target)]];

			return { install, move: [...install, ...update], update };
		},
		switchOn: Effect.succeed(Option.none<string>()),
		title: "pi",
		vendor: "anthropic",
	},
} as const satisfies Record<Harness, HarnessSetup>;

type HarnessName = keyof typeof harnesses;

export { harnesses };

export type { HarnessName, Installed, Move, Target };
