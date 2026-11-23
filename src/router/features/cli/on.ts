import { Array, Console, Effect, Record, Struct, pipe } from "effect";
import {
	claudeEnv,
	claudeSettings,
	exempted,
	exemptionName,
	exemptionReason,
	keptReason,
	recordReason,
	routerAddress,
	shellLists,
} from "./claude-settings.ts";
import { rewriteEnv, userSettings } from "#router/client/claude-code.ts";

/**
 * Why `on claude` writes `name`: the router's exemption, or the record `off` reads.
 *
 * @param {string} name The setting's name.
 * @returns {string} The reason.
 */
const reasonOf = (name: string): string => {
	if (name === exemptionName) {
		return exemptionReason;
	}

	return recordReason;
};

/**
 * Writes the settings a plugin cannot set into Claude Code's user settings, and, when the developer's own lists would
 * send Claude Code's requests to the router through a proxy, `no_proxy` with a record of what it wrote and what it
 * replaced for `off`. It writes nothing when every setting holds already, and gives the exemption and the file.
 */
const switchedOn = Effect.fnUntraced(function* switchedOn(configDir: string) {
	const settings = yield* userSettings(configDir);
	const shell = yield* shellLists;
	const exempt = exempted(routerAddress)({ settings: settings.env, shell });

	yield* rewriteEnv(configDir, Struct.assign(claudeEnv, exempt.set), exempt.unset);

	return { exempt, path: settings.path };
});

/** Writes what `switchedOn` writes, and prints each setting with its reason. */
const on = Effect.fn("on claude")(function* on(configDir: string) {
	const { exempt, path } = yield* switchedOn(configDir);

	const lines = pipe(
		claudeSettings,
		Array.flatMap(({ name, reason, value }) => [`${name}=${value}`, `  ${reason}`]),
	);

	const exemptionLines = pipe(
		Record.toEntries(exempt.set),
		Array.flatMap(([name, value]) => [`${name}=${value}`, `  ${reasonOf(name)}`]),
		Array.match({ onEmpty: () => [keptReason], onNonEmpty: (written) => written }),
	);

	const wrote = `phi-router wrote ${String(claudeSettings.length + Record.size(exempt.set))} settings to ${path}`;

	const restart =
		"Restart each open Claude Code session: it now sends to the router, which only a new session starts.";

	yield* Console.log(
		Array.join([wrote, ...lines, ...exemptionLines, restart, "Next: phi-router doctor claude"], "\n"),
	);
});

export { on, switchedOn };
