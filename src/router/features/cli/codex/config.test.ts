import { Array, Effect, Option, Record, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { codexSettings, dotted } from "./settings.ts";
import { inlineOwner, switchedOff, switchedOn } from "./config.ts";
import type { Setting } from "./settings.ts";
import { holds } from "./holds.ts";

const provider = `[model_providers.phi] # phi-router
name = "phi-router" # phi-router
base_url = "http://127.0.0.1:47411/v1" # phi-router
wire_api = "responses" # phi-router
requires_openai_auth = true # phi-router
request_max_retries = 2 # phi-router
stream_max_retries = 2 # phi-router
`;

const user = `# my Codex
model = "gpt-6-sol" # default

[features]
goals = true

[model_providers.other]
base_url = "http://example.invalid/v1"

[hooks.state."phi-router@phi-router:hooks/codex.json:session_start:0:0"]
trusted_hash = "sha256:aa"
`;

const userOn = `# my Codex
model = "gpt-6-sol" # default
model_provider = "phi" # phi-router
feedback.enabled = false # phi-router
experimental_realtime_ws_base_url = "http://127.0.0.1:47411/v1" # phi-router
experimental_realtime_webrtc_call_base_url = "http://127.0.0.1:47411/v1" # phi-router

[features]
unbounded_connection_retries = false # phi-router
goals = true

[model_providers.other]
base_url = "http://example.invalid/v1"

[hooks.state."phi-router@phi-router:hooks/codex.json:session_start:0:0"]
trusted_hash = "sha256:aa"

${provider}`;

const emptyOn = `model_provider = "phi" # phi-router
features.unbounded_connection_retries = false # phi-router
feedback.enabled = false # phi-router
experimental_realtime_ws_base_url = "http://127.0.0.1:47411/v1" # phi-router
experimental_realtime_webrtc_call_base_url = "http://127.0.0.1:47411/v1" # phi-router

${provider}`;

it.effect("on writes each setting into an empty file, and off gives the empty file back", () =>
	Effect.sync(() => {
		assert.strictEqual(switchedOn(""), emptyOn);
		assert.deepStrictEqual(switchedOff(emptyOn), {
			removed: [
				"model_provider",
				"features.unbounded_connection_retries",
				"feedback.enabled",
				"experimental_realtime_ws_base_url",
				"experimental_realtime_webrtc_call_base_url",
				"[model_providers.phi]",
				"model_providers.phi.name",
				"model_providers.phi.base_url",
				"model_providers.phi.wire_api",
				"model_providers.phi.requires_openai_auth",
				"model_providers.phi.request_max_retries",
				"model_providers.phi.stream_max_retries",
			],
			text: "",
		});
	}),
);

it.effect("on keeps every other line and comment, puts the switch in [features], and off gives them back", () =>
	Effect.sync(() => {
		assert.strictEqual(switchedOn(user), userOn);
		assert.strictEqual(switchedOn(userOn), userOn);
		assert.strictEqual(switchedOff(userOn).text, user);
	}),
);

/** Values of the developer's other than the ones `on` writes, by the value `on` writes. Any string becomes a URL. */
const flips: Record<string, string> = { "2": "7", false: "true", true: "false" };

const developerValue = (setting: Setting): string =>
	pipe(
		Record.get(flips, setting.value),
		Option.getOrElse(() => '"https://developer.example/v1"'),
	);

const lineOf = (setting: Setting, key: readonly string[]): string =>
	`${dotted(key)} = ${developerValue(setting)} # developer note\n`;

const atRoot = (setting: Setting): string =>
	`# mine\nmodel = "gpt-6-sol"\n${lineOf(setting, setting.path)}model_reasoning_effort = "high"\n\n[tui]\nanimations = false\n`;

const inTable = (setting: Setting, parent: readonly string[]): string =>
	`model = "gpt-6-sol"\n\n[${dotted(parent)}]\nfirst = 1\n${lineOf(setting, Array.drop(setting.path, parent.length))}last = 2 # theirs\n\n[tui]\nanimations = false\n`;

/**
 * Each setting `on` writes, seeded with a developer value and comment between other keys: once as a dotted key at the
 * root, and once in the table that holds it.
 */
const rootSeeds = pipe(
	codexSettings,
	Array.map((setting) => ({ key: dotted(setting.path), seed: atRoot(setting), setting })),
);

/** The key of a setting's own line in the table that holds it. */
const lastKey = 1;

const tableSeeds = pipe(
	codexSettings,
	Array.filter((setting) => setting.path.length > lastKey),
	Array.map((setting) => {
		const parent = Array.dropRight(setting.path, lastKey);

		return { key: `[${dotted(parent)}]`, seed: inTable(setting, parent), setting };
	}),
);

const seeded = [...rootSeeds, ...tableSeeds];

it.effect.each(seeded)("on then off gives back $key as the developer set it, byte for byte", ({ seed, setting }) =>
	Effect.sync(() => {
		const on = switchedOn(seed);

		assert.isTrue(holds(on)(setting), on);
		assert.strictEqual(switchedOn(on), on);
		assert.strictEqual(switchedOff(on).text, seed);
	}),
);

const spellings = [
	'model_providers.phi.base_url = "http://old/v1"\nmodel = "x"\n',
	'[model_providers]\nphi = { base_url = "http://old/v1" }\n',
	'[ model_providers . "phi" ]\nbase_url = "http://old/v1"\n[model_providers.phi.auth]\ncommand = "x"\n',
	"[model_providers.'phi']\nenv_key = 'K'\n",
	'model_provider = "openai"\nfeatures.unbounded_connection_retries = true\n',
	'feedback.enabled = true\nexperimental_realtime_ws_base_url = "wss://old"\n',
	"[feedback]\nenabled = true\n",
	"[ 'feedback' ]\n'enabled' = true\n",
];

it.effect.each(spellings)(
	"on records and replaces an old provider entry or setting spelled as %j, and off restores it",
	(spelled) =>
		Effect.sync(() => {
			const on = Str.replaceAll(/^# phi-router kept: .*\n/gmu, "")(switchedOn(spelled));

			assert.notInclude(on, "http://old");
			assert.notInclude(on, '"openai"');
			assert.notInclude(on, "env_key");
			assert.notInclude(on, "command");
			assert.notInclude(on, "unbounded_connection_retries = true");
			assert.notInclude(on, "enabled = true");
			assert.notInclude(on, "wss://old");
			assert.strictEqual(switchedOff(switchedOn(spelled)).text, spelled);
		}),
);

it.effect("off leaves a setting the user changed after on", () =>
	Effect.sync(() => {
		const changed = 'model_provider = "openai"\nfeatures.unbounded_connection_retries = true\n';

		assert.deepStrictEqual(switchedOff(changed), { removed: [], text: changed });
	}),
);

it.effect.each([
	{ owner: "model_providers", text: 'model_providers = { other = { base_url = "x" } }\n' },
	{ owner: "features", text: "features = { goals = true }\n" },
	{ owner: "feedback", text: "feedback = { enabled = true }\n" },
])("names $owner, a table held as one value that on cannot add to", ({ owner, text }) =>
	Effect.sync(() => {
		assert.deepStrictEqual(inlineOwner(text), Option.some(owner));
		assert.deepStrictEqual(inlineOwner(user), Option.none());
	}),
);
