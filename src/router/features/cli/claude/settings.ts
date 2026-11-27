import { Array, Config, Effect, Option, Path, Record, String as Str, pipe } from "effect";
import { callerHeader, loopback } from "#router/client/router-port/index.ts";
import type { PickerRow } from "#router/client/harnesses/index.ts";
import type { VendorLanes } from "#router/client/configuration/index.ts";
import { claudePluginData } from "#router/client/harnesses/index.ts";
import { configuredLanes } from "#router/client/configuration/index.ts";
import { piWire } from "#shared/pi.ts";
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
		value: "Your subscription, with PHI withheld behind handles",
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

const customHeadersSetting = "ANTHROPIC_CUSTOM_HEADERS";

const callerReason =
	"On Windows, Claude Code sends the router a token only your account can read, so another user's program cannot pass for you. Its value stays out of this output.";

const isCallerLine = (line: string): boolean => Str.startsWith(`${callerHeader}:`)(Str.toLowerCase(Str.trim(line)));

const headerLines = (headers: string): readonly string[] =>
	pipe(headers, Str.split(/\r?\n/u), Array.filter(Str.isNonEmpty));

const otherHeaderLines = (headers: string): readonly string[] =>
	pipe(
		headerLines(headers),
		Array.filter((line) => !isCallerLine(line)),
	);

const withCaller =
	(token: string) =>
	(headers: string): string =>
		Array.join([...otherHeaderLines(headers), `${callerHeader}: ${token}`], "\n");

const withoutCaller = (env: Variables): EnvChange => {
	const headers = Option.getOrElse(Record.get(env, customHeadersSetting), () => "");

	if (!pipe(headerLines(headers), Array.some(isCallerLine))) {
		return { set: {}, unset: [] };
	}

	const kept = otherHeaderLines(headers);

	if (Array.isReadonlyArrayEmpty(kept)) {
		return { set: {}, unset: [customHeadersSetting] };
	}

	return { set: { [customHeadersSetting]: Array.join(kept, "\n") }, unset: [] };
};

const launcherName = "phi-router";

const shellQuoted = (text: string): string => `'${Str.replaceAll("'", String.raw`'\''`)(text)}'`;

const statusLineCommand = Effect.fnUntraced(function* statusLineCommand(configDir: string) {
	const path = yield* Path.Path;
	const data = yield* claudePluginData(configDir, pluginId);

	return `${shellQuoted(path.join(data, launcherName))} statusline`;
});

const removedStatusLine = `phi-router removed the statusLine an earlier phi-router wrote. The plugin now shows phi-router's row under the prompt while the model is ${piWire.models.auto} or ${piWire.models.sealed}.`;

const phiModels = Record.values(piWire.models);

const pickerRowsOf = (lanes: VendorLanes): readonly PickerRow[] => [
	{ behavesAs: lanes.targetModel, model: piWire.models.auto },
	{
		behavesAs: lanes.sealedModel,
		description: "Your BAA account, for work that needs PHI",
		label: "PHI sealed",
		model: piWire.models.sealed,
	},
];

const pickerRows = Effect.gen(function* pickerRows() {
	const lanes = yield* configuredLanes;

	return pipe(
		lanes,
		Option.flatMap(({ anthropic }) => anthropic),
		Option.match({ onNone: (): readonly PickerRow[] => [], onSome: pickerRowsOf }),
	);
});

const pickerReason =
	"Claude Code gives each phi model the context window and capabilities of the model config.json runs it on.";

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
	callerReason,
	claudeEnv,
	customHeadersSetting,
	claudeSettings,
	exempted,
	exemption,
	exemptionName,
	exemptionReason,
	keptReason,
	modelAddressSetting,
	phiModels,
	pickerModel,
	pickerReason,
	pickerRows,
	pluginId,
	recordReason,
	removedStatusLine,
	restored,
	routerAddress,
	shellLists,
	statusLineCommand,
	withCaller,
	withoutCaller,
};

export type { NoProxyLists };
