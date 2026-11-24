import { Array, Effect, Option, Path, String as Str, Struct, pipe } from "effect";
import {
	addressEnv,
	codexSettings,
	doctorModel,
	dotenvFile,
	dotted,
	endsWithExemption,
	exemptionLine,
	holds,
	hookTrust,
	pinnedRoleFile,
	pluginEnabled,
	pluginId,
	provider,
	sealedRole,
} from "#router/features/cli/codex/index.ts";
import { canaryRun, reported } from "./canary.ts";
import { codexHome, codexPlugin, codexTurn, textOrEmpty } from "#router/client/harnesses/index.ts";
import type { Check } from "./canary.ts";

interface Install {
	readonly config: string;
	readonly dotenv: string;
	readonly role: string;
	readonly installed: boolean;
}

/**
 * One check per setting `on codex` writes, and one each for the exemption line in `.env`, the role file, the plugin's
 * enabling, its install in Codex's cache, and the human's trust of its hook.
 *
 * @param {Install} install What Codex's home holds.
 * @returns {readonly Check[]} The checks.
 */
const installChecks = (install: Install): readonly Check[] => [
	...pipe(
		codexSettings,
		Array.map((setting) => ({
			name: `${dotted(setting.path)} is ${setting.value}`,
			passed: holds(install.config)(setting),
		})),
	),
	{ name: `${dotenvFile} ends with ${exemptionLine}`, passed: endsWithExemption(install.dotenv) },
	{ name: `the role phi-sealed is in ${Array.join(pinnedRoleFile, "/")}`, passed: install.role === sealedRole },
	{ name: `the plugin ${pluginId} is enabled`, passed: pluginEnabled(install.config) },
	{ name: `the plugin ${pluginId} is installed`, passed: install.installed },
	{ name: "the plugin's hooks are trusted", passed: Str.isNonEmpty(hookTrust(install.config)) },
];

/**
 * The `config.toml` of the headless turn: the router at `address` as its provider with retries off, a fake key-command
 * login, analytics and the update check off, the plugin enabled, and the user's trust of its hook.
 *
 * @param {object} turn The router's address, and the trust table from the user's `config.toml`.
 * @returns {string} The file.
 */
const turnConfig = (turn: { readonly address: string; readonly trust: string }): string =>
	Array.join(
		[
			"check_for_update_on_startup = false",
			`model = "${doctorModel}"`,
			'model_provider = "phi"',
			"[analytics]",
			"enabled = false",
			"[features]",
			"unbounded_connection_retries = false",
			`[${dotted(provider)}]`,
			'name = "phi-router"',
			`base_url = "${turn.address}/v1"`,
			'wire_api = "responses"',
			"request_max_retries = 0",
			"stream_max_retries = 0",
			'http_headers = { "ChatGPT-Account-ID" = "phi-doctor-account" }',
			`[${dotted([...provider, "auth"])}]`,
			'command = "echo"',
			'args = ["phi-doctor-login"]',
			`[${dotted(["plugins", pluginId])}]`,
			"enabled = true",
			turn.trust,
			"",
		],
		"\n",
	);

/**
 * The canary run of `codex exec` through the plugin in `folder`, copied to `place` in the turn's Codex home, on the hook
 * trust `trust` from the user's `config.toml`, or with no trust needed when it is empty.
 */
const codexCanary = Effect.fnUntraced(function* codexCanary(install: {
	readonly folder: string;
	readonly place: string;
	readonly trust: string;
}) {
	const trusted = Option.match(Option.liftPredicate(install.trust, Str.isNonEmpty), {
		onNone: () => "bypassed" as const,
		onSome: () => "persisted" as const,
	});

	return yield* canaryRun(
		{ binary: "codex", headless: "codex exec", vendor: "openai" },
		({ mockEnv, prompt, routerAddress }) =>
			codexTurn({
				config: turnConfig({ address: routerAddress, trust: install.trust }),
				dotenv: exemptionLine,
				env: Struct.assign(mockEnv, { [addressEnv]: routerAddress }),
				hookTrust: trusted,
				installedPlugin: install.folder,
				pluginCachePlace: install.place,
				prompt,
			}),
	);
});

/**
 * Checks the settings, the role, and the plugin's install and trust first, and stops there when one fails, since an
 * untrusted hook looks like a network failure. Then it runs the canary through the installed plugin, and passes only
 * when `codex exec` exited 0, the canary arrived at the BAA mock, and it arrived at no open mock. It changes no setting,
 * and never touches the product port, the user's router configuration, or a real account.
 */
const doctorCodex = Effect.fn("doctor codex")(function* doctorCodex(named: string) {
	const path = yield* Path.Path;
	const home = yield* codexHome(named);
	const config = yield* textOrEmpty(path.join(home, "config.toml"));
	const dotenv = yield* textOrEmpty(path.join(home, dotenvFile));
	const role = yield* textOrEmpty(path.join(home, ...pinnedRoleFile));
	const installed = yield* codexPlugin(path.join(home, "plugins", "cache", "phi-router", "phi-router"));

	yield* reported(
		"codex",
		installChecks({ config, dotenv, installed: Option.isSome(installed), role }),
		`Run phi-router on codex for a missing setting, line or role, codex plugin add ${pluginId} for the plugin, and start codex and pick "Trust all and continue" for the hooks.`,
	);

	const checks = yield* Option.match(installed, {
		onNone: () => Effect.succeed([]),
		onSome: (folder) => codexCanary({ folder, place: path.relative(home, folder), trust: hookTrust(config) }),
	});

	yield* reported(
		"codex",
		checks,
		`The canary must reach the BAA mock alone, through the router the plugin's hook starts. Each FAIL line names what did not hold. When codex exec fails, run codex plugin add ${pluginId} again and trust its hooks.`,
	);
});

export { codexCanary, doctorCodex };
