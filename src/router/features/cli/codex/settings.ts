import { Array, Option, String as Str, pipe } from "effect";
import { loopback, productPort } from "#shared/cli.ts";
import { pinnedLine, pinnedModel } from "#router/features/lanes/index.ts";

interface Setting {
	readonly path: readonly string[];
	readonly value: string;
	readonly reason: string;
}

const providerId = "phi";

const provider = ["model_providers", providerId];

const routerUrl = `"http://${loopback}:${String(productPort)}/v1"`;

const pluginId = "phi-router@phi-router";

const hookKeys = pipe(
	[
		"session_start:0:0",
		"user_prompt_submit:0:0",
		"user_prompt_submit:0:1",
		"user_prompt_submit:0:2",
		"stop:0:0",
		"pre_compact:0:0",
	],
	Array.map((hook) => `${pluginId}:hooks/codex.json:${hook}`),
);

const doctorModel = "phi/auto";

const addressEnv = "PHI_ROUTER_ADDRESS";

const pinnedRoleFile = ["agents", "phi-sealed.toml"];

const codexSettings: readonly Setting[] = [
	{
		path: ["model_provider"],
		reason: "Codex sends every model request to the router, whatever model it names.",
		value: '"phi"',
	},
	{
		path: ["features", "unbounded_connection_retries"],
		reason:
			"With no router up, a prompt ends in a connection error instead of waiting for the network forever. This holds for every provider.",
		value: "false",
	},
	{
		path: ["feedback", "enabled"],
		reason: "/feedback would upload Codex's logs and the session's transcript to OpenAI, outside the router.",
		value: "false",
	},
	{
		path: ["experimental_realtime_ws_base_url"],
		reason:
			"/voice connects to the router, which refuses it, so your speech and the session's recent turns never reach OpenAI directly, whatever provider a session uses.",
		value: routerUrl,
	},
	{
		path: ["experimental_realtime_webrtc_call_base_url"],
		reason: "/voice sets up its call through the router too, which refuses it.",
		value: routerUrl,
	},
	{ path: [...provider, "name"], reason: "Names the router in /status.", value: '"phi-router"' },
	{
		path: [...provider, "base_url"],
		reason: "The router's address, at the literal 127.0.0.1 and never localhost.",
		value: routerUrl,
	},
	{ path: [...provider, "wire_api"], reason: "The router speaks the Responses API.", value: '"responses"' },
	{
		path: [...provider, "requires_openai_auth"],
		reason: "Codex forwards its ChatGPT login, which the router passes only to your open account.",
		value: "true",
	},
	{
		path: [...provider, "request_max_retries"],
		reason: "A request the router refuses fails after two retries.",
		value: "2",
	},
	{
		path: [...provider, "stream_max_retries"],
		reason: "A reply stream that breaks fails after two retries.",
		value: "2",
	},
];

const sealedInstructions = `${pinnedLine}
You run on a BAA account and may read PHI. You start with a fresh context, so read your sources again with your tools. Answer with internal ids, your organization's own record ids such as a patient_id, never with names, SSNs, MRNs or other direct identifiers.
`;

const sealedRole = `name = "phi-sealed"
description = "Works with PHI on the BAA account. Start it when a task needs the content of a sealed message. It reads its sources again with its own tools and answers with internal ids only."
model = "${pinnedModel}"
developer_instructions = """
${sealedInstructions}"""
`;

const dotenvFile = ".env";

const exemptionLine = `NO_PROXY="\${NO_PROXY},\${no_proxy},${loopback}" # added by phi-router on`;

const exemptionReason =
	"Codex reaches the router without your proxy, which would see every prompt in plain HTTP. Your own NO_PROXY and no_proxy come first, as your shell gives them when Codex starts.";

const linesOf = Str.split("\n");

const isExemption = (line: string): boolean => Str.trimEnd(line) === exemptionLine;

const holdsExemption = (text: string): boolean => Array.some(linesOf(text), isExemption);

const endsWithExemption = (text: string): boolean =>
	pipe(linesOf(text), Array.filter(Str.isNonEmpty), Array.last, Option.exists(isExemption));

const withoutExemption = (text: string): Option.Option<string> =>
	pipe(
		linesOf(text),
		Array.filter((line) => !isExemption(line)),
		Array.join("\n"),
		Option.liftPredicate(Str.isNonEmpty),
	);

const withExemption = (text: string): string => {
	const rest = Option.getOrElse(withoutExemption(text), () => "");

	if (Str.isEmpty(rest) || Str.endsWith("\n")(rest)) {
		return `${rest}${exemptionLine}\n`;
	}

	return `${rest}\n${exemptionLine}\n`;
};

const bare = /^[\w-]+$/u;

const dotted = (path: readonly string[]): string =>
	pipe(
		path,
		Array.map((segment) => {
			if (bare.test(segment)) {
				return segment;
			}

			return `"${segment}"`;
		}),
		Array.join("."),
	);

export {
	addressEnv,
	codexSettings,
	doctorModel,
	dotenvFile,
	dotted,
	endsWithExemption,
	exemptionLine,
	exemptionReason,
	holdsExemption,
	hookKeys,
	pinnedRoleFile,
	pluginId,
	provider,
	providerId,
	sealedRole,
	withExemption,
	withoutExemption,
};

export type { Setting };
