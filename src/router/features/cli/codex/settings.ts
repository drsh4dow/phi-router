import { Array, Option, String as Str, pipe } from "effect";
import { loopback, productPort } from "#shared/cli.ts";
import { pinnedLine, pinnedModel } from "#router/features/lanes/index.ts";

/** One setting a plugin cannot set, which `on codex` writes into Codex's `config.toml`: its key and its TOML value. */
interface Setting {
	readonly path: readonly string[];
	readonly value: string;
	readonly reason: string;
}

/** The id of the router's provider, which a session's transcript names when the session sends to the router. */
const providerId = "phi";

/** The provider entry, every key under which `on codex` owns. */
const provider = ["model_providers", providerId];

const routerUrl = `"http://${loopback}:${String(productPort)}/v1"`;

/** The plugin's id as Codex keys it: the plugin's name at the marketplace's name. */
const plugin = "phi-router@phi-router";

/**
 * The keys Codex stores the trust of the plugin's hooks under, in `[hooks.state]`, one per hook in `hooks/codex.json`:
 * the session-start hook, which starts the router, the three prompt hooks, which answer `/phi`, block a prompt of a
 * session that sends elsewhere and block a prompt the router's port cannot prove is yours, the turn-end hook, and the
 * compaction hook, which blocks a compaction the port cannot prove is yours.
 */
const hookKeys = pipe(
	[
		"session_start:0:0",
		"user_prompt_submit:0:0",
		"user_prompt_submit:0:1",
		"user_prompt_submit:0:2",
		"stop:0:0",
		"pre_compact:0:0",
	],
	Array.map((hook) => `${plugin}:hooks/codex.json:${hook}`),
);

/** The model name `doctor codex` asks for. */
const auto = "phi/auto";

/**
 * The environment variable that gives the plugin's hook the router's address. Codex tells a hook nothing of its
 * provider, so the hook reads this, and `http://127.0.0.1:47411` when it is unset. Only `doctor codex` sets it.
 */
const addressEnv = "PHI_ROUTER_ADDRESS";

/** The file under Codex's home that holds the pinned subagent's role. */
const roleFile = ["agents", "phi-sealed.toml"];

/** The settings `on codex` writes and prints, `off codex` removes and `doctor codex` checks. */
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

/**
 * The pinned subagent's instructions, the same in Codex's role and in Claude Code's agent file. The description, which
 * each main agent sees, leaves out `pinnedLine`, so the main session never pins itself.
 */
const sealedInstructions = `${pinnedLine}
You run on a BAA account and may read PHI. You start with a fresh context, so read your sources again with your tools. Answer with internal ids, your organization's own record ids such as a patient_id, never with names, SSNs, MRNs or other direct identifiers.
`;

/** The pinned subagent's role, which a plugin cannot ship, so `on codex` writes it to `agents/phi-sealed.toml`. */
const sealedRole = `name = "phi-sealed"
description = "Works with PHI on the BAA account. Start it when a task needs the content of a sealed message. It reads its sources again with its own tools and answers with internal ids only."
model = "${pinnedModel}"
developer_instructions = """
${sealedInstructions}"""
`;

/**
 * The file under Codex's home that Codex loads into its own environment when it starts, each `${NAME}` in a value taken
 * from the environment it already has.
 */
const dotenvFile = ".env";

/**
 * The line `on codex` adds to `.env`. Codex reads `NO_PROXY` over `no_proxy`, so this one setting keeps the developer's
 * own list under either spelling, whatever it is when Codex starts, and adds 127.0.0.1, which takes Codex's requests
 * to the router off their proxy. Codex skips a host and port there, so the entry is the bare address. Its comment marks
 * it as the line `on` wrote, so `off` leaves a line of the developer's own alone.
 */
const exemptionLine = `NO_PROXY="\${NO_PROXY},\${no_proxy},${loopback}" # added by phi-router on`;

const exemptionReason =
	"Codex reaches the router without your proxy, which would see every prompt in plain HTTP. Your own NO_PROXY and no_proxy come first, as your shell gives them when Codex starts.";

const linesOf = Str.split("\n");

/**
 * Whether `line` is the router's exemption line, also as an editor that ends lines with CRLF saves it.
 *
 * @param {string} line A line of `.env`.
 * @returns {boolean} Whether it is the line.
 */
const isExemption = (line: string): boolean => Str.trimEnd(line) === exemptionLine;

/**
 * Whether `.env` holds the router's exemption line anywhere.
 *
 * @param {string} text The file's text.
 * @returns {boolean} Whether it holds the line.
 */
const holdsExemption = (text: string): boolean => Array.some(linesOf(text), isExemption);

/**
 * Whether the router's exemption line is the last line of `.env` that is not blank, so no later line of the
 * developer's sets `NO_PROXY` over it.
 *
 * @param {string} text The file's text.
 * @returns {boolean} Whether it ends with the line.
 */
const endsWithExemption = (text: string): boolean =>
	pipe(linesOf(text), Array.filter(Str.isNonEmpty), Array.last, Option.exists(isExemption));

/**
 * `.env` without the router's exemption line, every other line and every newline kept.
 *
 * @param {string} text The file's text.
 * @returns {Option.Option<string>} The text `off codex` leaves, none when the line was all the file held.
 */
const withoutExemption = (text: string): Option.Option<string> =>
	pipe(
		linesOf(text),
		Array.filter((line) => !isExemption(line)),
		Array.join("\n"),
		Option.liftPredicate(Str.isNonEmpty),
	);

/**
 * `.env` with the router's exemption line moved or added to its end, so no line of the developer's sets `NO_PROXY`
 * after it. The line ends with a newline, so a line the developer appends later stays its own line.
 *
 * @param {string} text The file's text, empty when there is no file.
 * @returns {string} The text `on codex` writes.
 */
const withExemption = (text: string): string => {
	const rest = Option.getOrElse(withoutExemption(text), () => "");

	if (Str.isEmpty(rest) || Str.endsWith("\n")(rest)) {
		return `${rest}${exemptionLine}\n`;
	}

	return `${rest}\n${exemptionLine}\n`;
};

const bare = /^[\w-]+$/u;

/**
 * A key as TOML spells it with dots, each segment quoted unless it is bare.
 *
 * @param {readonly string[]} path The key's segments.
 * @returns {string} The dotted key.
 */
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
	auto,
	codexSettings,
	dotenvFile,
	dotted,
	endsWithExemption,
	exemptionLine,
	exemptionReason,
	holdsExemption,
	hookKeys,
	plugin,
	provider,
	providerId,
	roleFile,
	sealedRole,
	withExemption,
	withoutExemption,
};

export type { Setting };
