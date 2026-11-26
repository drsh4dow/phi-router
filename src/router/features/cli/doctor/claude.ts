import { Array, Console, Effect, Option, Order, String as Str, Struct, pipe } from "effect";
import { canaryRun, reported } from "./canary.ts";
import {
	claudeEnv,
	claudeSettings,
	exempted,
	exemption,
	modelAddressSetting,
	pickerModel,
	pluginId,
	routerAddress,
	shellLists,
} from "#router/features/cli/claude/index.ts";
import { claudePlugin, claudeTurn, claudeVersion, userSettings } from "#router/client/harnesses/index.ts";
import type { Check } from "./canary.ts";
import type { NoProxyLists } from "#router/features/cli/claude/index.ts";
import type { UserSettings } from "#router/client/harnesses/index.ts";

interface Found {
	readonly installed: boolean;
	readonly settings: UserSettings;
	readonly shell: NoProxyLists["shell"];
}

const settingsChecks = ({ installed, settings, shell }: Found): readonly Check[] => [
	...pipe(
		claudeSettings,
		Array.map(({ name, value }) => ({ name: `${name} is ${value}`, passed: settings.env[name] === value })),
	),
	{
		name: `no_proxy or NO_PROXY takes Claude Code to ${routerAddress} without a proxy`,
		passed: Option.isNone(exemption(routerAddress)({ settings: settings.env, shell })),
	},
	{ name: `the plugin ${pluginId} is enabled`, passed: pipe(settings.enabledPlugins, Array.contains(pluginId)) },
	{ name: `the plugin ${pluginId} is installed`, passed: installed },
];

const statusRowSince = "2.1.332";

const versionPattern = /^\d+\.\d+\.\d+/u;

const versionOf = (printed: string): Option.Option<string> =>
	pipe(
		Option.fromNullishOr(versionPattern.exec(printed)),
		Option.map(([version]) => version),
	);

const partsOf = (version: string): readonly number[] => pipe(Str.split(version, "."), Array.map(Number));

const olderThan = Order.isLessThan(Order.Array(Order.Number));

const versionNote = (printed: string): Option.Option<string> =>
	pipe(
		versionOf(printed),
		Option.filter((version) => olderThan(partsOf(version), partsOf(statusRowSince))),
		Option.map(
			(version) =>
				`note: Claude Code ${version} is older than ${statusRowSince}, so it shows no phi-router row under the prompt and answers /phi as a blocked prompt. Routing works the same. Run claude update to get both.`,
		),
	);

const claudeCanary = Effect.fnUntraced(function* claudeCanary(folder: string) {
	return yield* canaryRun({ binary: "claude", headless: "claude -p", vendor: "anthropic" }, (canaried) =>
		claudeTurn({
			env: canaried.mockEnv,
			model: pickerModel,
			pluginFolder: folder,
			prompt: canaried.prompt,
			settingsEnv: Struct.assign(
				Struct.assign(claudeEnv, { [modelAddressSetting]: canaried.routerAddress }),
				exempted(canaried.routerAddress)({ settings: {}, shell: {} }).set,
			),
		}),
	);
});

const doctorClaude = Effect.fn("doctor claude")(function* doctorClaude(configDir: string) {
	const settings = yield* userSettings(configDir);
	const installed = yield* claudePlugin(configDir, pluginId);
	const shell = yield* shellLists;

	yield* reported(
		"claude",
		settingsChecks({ installed: Option.isSome(installed), settings, shell }),
		`Run phi-router on claude for a missing setting, and claude plugin install ${pluginId} for the plugin.`,
	);

	const note = yield* Effect.map(Effect.option(claudeVersion), Option.flatMap(versionNote));

	yield* Option.match(note, { onNone: () => Effect.void, onSome: Console.log });

	const checks = yield* Option.match(installed, {
		onNone: () => Effect.succeed([]),
		onSome: ({ installPath }) => claudeCanary(installPath),
	});

	yield* reported(
		"claude",
		checks,
		`The canary must reach the open mock only as a stub with its handle, through the router the plugin's hook starts. Each FAIL line names what did not hold. When claude -p fails, run claude plugin install ${pluginId} again.`,
	);
});

export { claudeCanary, doctorClaude, versionNote };
