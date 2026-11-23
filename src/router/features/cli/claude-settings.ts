import { Array, Config, Effect, Option, Record, String as Str, pipe } from "effect";
import { loopback } from "#router/client/server.ts";
import { productPort } from "#shared/cli.ts";

/** One setting a plugin cannot set, which `on claude` writes into the `env` block of Claude Code's user settings. */
interface Setting {
	readonly name: string;
	readonly value: string;
	readonly reason: string;
}

/** The setting that holds the model address. */
const modelAddress = "ANTHROPIC_BASE_URL";

/** The plugin's id as `enabledPlugins` holds it: the plugin's name at the marketplace's name. */
const plugin = "phi-router@phi-router";

/** The model name `on claude` adds to the picker, and the one `doctor claude` asks for. */
const auto = "phi/auto";

/** The router's address, at the literal 127.0.0.1 and never localhost. */
const routerAddress = `http://${loopback}:${String(productPort)}`;

/** The settings `on claude` writes and prints, `off claude` removes and `doctor claude` checks. */
const claudeSettings: readonly Setting[] = [
	{
		name: modelAddress,
		reason: "Claude Code sends every model request to the router, at the literal 127.0.0.1 and never localhost.",
		value: routerAddress,
	},
	{ name: "ANTHROPIC_CUSTOM_MODEL_OPTION", reason: "Adds phi/auto to the /model picker.", value: auto },
	{ name: "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME", reason: "Names phi/auto in the picker.", value: "PHI auto" },
	{
		name: "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
		reason: "Describes phi/auto in the picker.",
		value: "An open account when a request is clean, a BAA account when it holds PHI",
	},
	{
		name: "CLAUDE_CODE_GATEWAY_HINT_HEADERS",
		reason:
			"Claude Code names each request's class, so the router can tell a subagent or a compaction from the main loop.",
		value: "1",
	},
	{
		name: "DISABLE_FEEDBACK_COMMAND",
		reason: "/feedback would send the conversation to Anthropic past the router.",
		value: "1",
	},
	{ name: "DISABLE_TELEMETRY", reason: "Telemetry would go to Anthropic past the router.", value: "1" },
	{ name: "DISABLE_ERROR_REPORTING", reason: "Error reports would go to a third party past the router.", value: "1" },
];

/** The settings as the `env` block holds them. */
const claudeEnv = pipe(
	claudeSettings,
	Array.map(({ name, value }) => [name, value] as const),
	Record.fromEntries,
);

/**
 * The two spellings of the list of hosts Claude Code reaches without the developer's proxy. A value in the `env` block of
 * its settings replaces the one its shell gives it, and it reads `no_proxy` first and `NO_PROXY` when that is empty.
 */
const exemptionNames = ["no_proxy", "NO_PROXY"] as const;

/** The one setting `on claude` writes when Claude Code would send its requests to the router through a proxy. */
const exemptionName = "no_proxy";

/**
 * What `on claude` records beside its `no_proxy`, so `off claude` gives back exactly what was there: the value it wrote,
 * and the developer's own `no_proxy` setting it replaced, when there was one.
 */
const exemptionRecord = { replaced: "PHI_ROUTER_REPLACED_no_proxy", wrote: "PHI_ROUTER_WROTE_no_proxy" } as const;

const exemptionReason =
	"Claude Code reaches the router without your proxy, which would see every prompt in plain HTTP. It holds the list Claude Code read before, then the router. Claude Code reads it here instead of from your shell from now on, so change it here. phi-router off gives back what was here before.";

const recordReason = "phi-router off reads it to give no_proxy back as it was before on.";

const keptReason =
	"no_proxy or NO_PROXY already takes Claude Code to the router without your proxy, so phi-router left them as they are.";

/**
 * `no_proxy` and `NO_PROXY` as the developer's shell gives them, empty when unset. The launcher adds 127.0.0.1 to both
 * for the CLI's own requests, so it keeps the shell's values under `PHI_ROUTER_GIVEN_` and sets `PHI_ROUTER_LAUNCHED`.
 * Config reads an empty variable as unset, so the flag, not the kept value, says which names hold the shell's lists.
 */
const shellLists = Effect.gen(function* shellLists() {
	const launched = yield* Config.Boolean("PHI_ROUTER_LAUNCHED").pipe(Config.withDefault(false));

	const given = (name: string): string => {
		if (launched) {
			return `PHI_ROUTER_GIVEN_${name}`;
		}

		return name;
	};

	const values = yield* Effect.forEach(
		exemptionNames,
		(name) => Effect.map(Config.String(given(name)).pipe(Config.withDefault("")), (value) => [name, value] as const),
		{ concurrency: 1 },
	);

	return Record.fromEntries(values);
});

/** The settings of Claude Code's `env` block, or of the shell, by name. */
type Values = Readonly<Record<string, string>>;

/** The developer's own lists of hosts to reach without a proxy: in Claude Code's settings, and in their shell. */
interface Own {
	readonly settings: Values;
	readonly shell: Values;
}

/**
 * The list of hosts Claude Code reaches without a proxy, as it reads it from its settings over its shell.
 *
 * @param {Own} own The developer's settings and shell.
 * @returns {string} The list, empty when there is none.
 */
const exemptList = (own: Own): string =>
	pipe(
		exemptionNames,
		Array.map((name) =>
			pipe(
				Record.get(own.settings, name),
				Option.orElse(() => Record.get(own.shell, name)),
				Option.getOrElse(() => ""),
			),
		),
		Array.findFirst(Str.isNonEmpty),
		Option.getOrElse(() => ""),
	);

/**
 * Whether the list `list` takes Claude Code to the router at `address` without a proxy. Each entry counts that was
 * measured to: `*`, `127.0.0.1`, `127.0.0.0/8`, and the router's host and port.
 *
 * @param {string} address The router's address.
 * @returns {Function} The check of a list.
 */
const keepsDirect =
	(address: string) =>
	(list: string): boolean =>
		pipe(
			Str.split(/[\s,]+/u)(list),
			Array.some((entry) => Array.contains(["*", "127.0.0.1", "127.0.0.0/8", new URL(address).host], entry)),
		);

/**
 * The `no_proxy` `on claude` writes for the router at `address`: the list Claude Code reads now, then the router's host
 * and port. None when that list already takes Claude Code to the router without a proxy.
 *
 * @param {string} address The router's address.
 * @returns {Function} The value, from the developer's settings and shell.
 */
const exemption =
	(address: string) =>
	(own: Own): Option.Option<string> => {
		const list = exemptList(own);
		const { host } = new URL(address);

		if (keepsDirect(address)(list)) {
			return Option.none();
		}

		if (Str.isEmpty(list)) {
			return Option.some(host);
		}

		return Option.some(`${list},${host}`);
	};

/** A change to the settings' `env` block: the values it sets and the keys it removes. */
interface EnvChange {
	readonly set: Values;
	readonly unset: readonly string[];
}

/**
 * What `on claude` does for the router's exemption: it writes the `no_proxy` that `exemption` gives, if any, and records
 * that value and the developer's own `no_proxy` setting it replaces, or drops a stale record of one when there is none.
 *
 * @param {string} address The router's address.
 * @returns {Function} The change, from the developer's settings and shell.
 */
const exempted =
	(address: string) =>
	(own: Own): EnvChange =>
		Option.match(exemption(address)(own), {
			onNone: () => ({ set: {}, unset: [] }),
			onSome: (wrote) =>
				Option.match(Record.get(own.settings, exemptionName), {
					onNone: () => ({
						set: { [exemptionName]: wrote, [exemptionRecord.wrote]: wrote },
						unset: [exemptionRecord.replaced],
					}),
					onSome: (replaced) => ({
						set: { [exemptionName]: wrote, [exemptionRecord.replaced]: replaced, [exemptionRecord.wrote]: wrote },
						unset: [],
					}),
				}),
		});

/**
 * What `off claude` does with what `on claude` recorded in the settings' `env` block. While `no_proxy` still holds the
 * value `on` wrote, it gives back the developer's own value, or removes `no_proxy` when there was none. It leaves a
 * `no_proxy` changed since, and removes the record either way. Without a record it changes nothing.
 *
 * @param {Values} env The `env` block of the settings.
 * @returns {EnvChange} The values it gives back and the keys it removes.
 */
const restored = (env: Values): EnvChange => {
	const record = [exemptionRecord.wrote, exemptionRecord.replaced];
	const wrote = Record.get(env, exemptionRecord.wrote);

	if (Option.isNone(wrote)) {
		return { set: {}, unset: [] };
	}

	if (env[exemptionName] !== wrote.value) {
		return { set: {}, unset: record };
	}

	return Option.match(Record.get(env, exemptionRecord.replaced), {
		onNone: () => ({ set: {}, unset: [exemptionName, ...record] }),
		onSome: (replaced) => ({ set: { [exemptionName]: replaced }, unset: record }),
	});
};

export {
	auto,
	claudeEnv,
	claudeSettings,
	exempted,
	exemption,
	exemptionName,
	exemptionReason,
	keptReason,
	modelAddress,
	plugin,
	recordReason,
	restored,
	routerAddress,
	shellLists,
};

export type { Own };
