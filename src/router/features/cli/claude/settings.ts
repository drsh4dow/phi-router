import { Array, Config, Effect, Option, Record, String as Str, pipe } from "effect";
import { loopback } from "#router/client/router-port/index.ts";
import { productPort } from "#shared/cli.ts";

interface Setting {
	readonly name: string;
	readonly value: string;
	readonly reason: string;
}

const modelAddressSetting = "ANTHROPIC_BASE_URL";

const pluginId = "phi-router@phi-router";

const pickerModel = "phi/auto";

const routerAddress = `http://${loopback}:${String(productPort)}`;

const claudeSettings: readonly Setting[] = [
	{
		name: modelAddressSetting,
		reason: "Claude Code sends every model request to the router, at the literal 127.0.0.1 and never localhost.",
		value: routerAddress,
	},
	{ name: "ANTHROPIC_CUSTOM_MODEL_OPTION", reason: "Adds phi/auto to the /model picker.", value: pickerModel },
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

const claudeEnv = pipe(
	claudeSettings,
	Array.map(({ name, value }) => [name, value] as const),
	Record.fromEntries,
);

const exemptionNames = ["no_proxy", "NO_PROXY"] as const;

const exemptionName = "no_proxy";

const exemptionRecord = { replaced: "PHI_ROUTER_REPLACED_no_proxy", wrote: "PHI_ROUTER_WROTE_no_proxy" } as const;

const exemptionReason =
	"Claude Code reaches the router without your proxy, which would see every prompt in plain HTTP. It holds the list Claude Code read before, then the router. Claude Code reads it here instead of from your shell from now on, so change it here. phi-router off gives back what was here before.";

const recordReason = "phi-router off reads it to give no_proxy back as it was before on.";

const keptReason =
	"no_proxy or NO_PROXY already takes Claude Code to the router without your proxy, so phi-router left them as they are.";

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

type Variables = Readonly<Record<string, string>>;

interface NoProxyLists {
	readonly settings: Variables;
	readonly shell: Variables;
}

const exemptList = (lists: NoProxyLists): string =>
	pipe(
		exemptionNames,
		Array.map((name) =>
			pipe(
				Record.get(lists.settings, name),
				Option.orElse(() => Record.get(lists.shell, name)),
				Option.getOrElse(() => ""),
			),
		),
		Array.findFirst(Str.isNonEmpty),
		Option.getOrElse(() => ""),
	);

const keepsDirect =
	(address: string) =>
	(list: string): boolean =>
		pipe(
			Str.split(/[\s,]+/u)(list),
			Array.some((entry) => Array.contains(["*", "127.0.0.1", "127.0.0.0/8", new URL(address).host], entry)),
		);

const exemption =
	(address: string) =>
	(lists: NoProxyLists): Option.Option<string> => {
		const list = exemptList(lists);
		const { host } = new URL(address);

		if (keepsDirect(address)(list)) {
			return Option.none();
		}

		if (Str.isEmpty(list)) {
			return Option.some(host);
		}

		return Option.some(`${list},${host}`);
	};

interface EnvChange {
	readonly set: Variables;
	readonly unset: readonly string[];
}

const exempted =
	(address: string) =>
	(lists: NoProxyLists): EnvChange =>
		Option.match(exemption(address)(lists), {
			onNone: () => ({ set: {}, unset: [] }),
			onSome: (wrote) =>
				Option.match(Record.get(lists.settings, exemptionName), {
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

const restored = (env: Variables): EnvChange => {
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
	claudeEnv,
	claudeSettings,
	exempted,
	exemption,
	exemptionName,
	exemptionReason,
	keptReason,
	modelAddressSetting,
	pickerModel,
	pluginId,
	recordReason,
	restored,
	routerAddress,
	shellLists,
};

export type { NoProxyLists };
