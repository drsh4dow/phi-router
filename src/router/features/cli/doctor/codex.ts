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
		`The canary must reach the open mock only as a stub with its handle, through the router the plugin's hook starts. Each FAIL line names what did not hold. When codex exec fails, run codex plugin add ${pluginId} again and trust its hooks.`,
	);
});

export { codexCanary, doctorCodex, turnConfig };
