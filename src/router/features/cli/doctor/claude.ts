import { Array, Effect, Option, Struct, pipe } from "effect";
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
import { claudePlugin, claudeTurn, userSettings } from "#router/client/harnesses/index.ts";
import type { Check } from "./canary.ts";
import type { NoProxyLists } from "#router/features/cli/claude/index.ts";
import type { UserSettings } from "#router/client/harnesses/index.ts";

interface Found {
	readonly installed: boolean;
	readonly settings: UserSettings;
	readonly shell: NoProxyLists["shell"];
}

/**
 * One check per setting `on claude` writes, which holds when the `env` block has its value, one that holds when the list
 * of hosts Claude Code reaches without a proxy, from its settings over the shell, takes it to the router, and two for
 * the plugin, which hold when `enabledPlugins` holds its id at `true` and Claude Code installed it.
 *
 * @param {object} found What the user's settings and shell hold, and whether Claude Code installed the plugin.
 * @param {boolean} found.installed Whether Claude Code installed the plugin.
 * @param {UserSettings} found.settings What the user's settings hold.
 * @param {object} found.shell `no_proxy` and `NO_PROXY` as the shell gives them.
 * @returns {readonly Check[]} The checks.
 */
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

/**
 * The canary run of `claude -p` through the plugin Claude Code installed in `folder`, with the settings `on claude`
 * writes and the router at the run's own address.
 */
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

/**
 * Checks the settings and the plugin's install first, and stops there when one fails, since Claude Code would only
 * retry a refused connection for three minutes. Then it runs the canary through the installed plugin, and passes only
 * when `claude` exited 0, the canary arrived at the BAA mock, and it arrived at no open mock. It changes no setting, and
 * never touches the product port, the user's router configuration, or a real account.
 */
const doctorClaude = Effect.fn("doctor claude")(function* doctorClaude(configDir: string) {
	const settings = yield* userSettings(configDir);
	const installed = yield* claudePlugin(configDir, pluginId);
	const shell = yield* shellLists;

	yield* reported(
		"claude",
		settingsChecks({ installed: Option.isSome(installed), settings, shell }),
		`Run phi-router on claude for a missing setting, and claude plugin install ${pluginId} for the plugin.`,
	);

	const checks = yield* Option.match(installed, { onNone: () => Effect.succeed([]), onSome: claudeCanary });

	yield* reported(
		"claude",
		checks,
		`The canary must reach the BAA mock alone, through the router the plugin's hook starts. Each FAIL line names what did not hold. When claude -p fails, run claude plugin install ${pluginId} again.`,
	);
});

export { claudeCanary, doctorClaude };
