import { Effect, FileSystem } from "effect";
import { folder } from "#tools/claude/configured.ts";

const written = `model_provider = "phi" # phi-router
features.unbounded_connection_retries = false # phi-router
feedback.enabled = false # phi-router
experimental_realtime_ws_base_url = "http://127.0.0.1:47411/v1" # phi-router
experimental_realtime_webrtc_call_base_url = "http://127.0.0.1:47411/v1" # phi-router

[model_providers.phi] # phi-router
name = "phi-router" # phi-router
base_url = "http://127.0.0.1:47411/v1" # phi-router
wire_api = "responses" # phi-router
requires_openai_auth = true # phi-router
request_max_retries = 2 # phi-router
stream_max_retries = 2 # phi-router
`;

const exemptionLine = `NO_PROXY="\${NO_PROXY},\${no_proxy},127.0.0.1" # added by phi-router on`;

/** The plugin enabled, as `codex plugin add` writes it. */
const enabled = '\n[plugins."phi-router@phi-router"]\nenabled = true\n';

/** The trust Codex stores once the human trusts the plugin's hooks. The hashes are made up. */
const trusted = `
[hooks.state]

[hooks.state."phi-router@phi-router:hooks/codex.json:session_start:0:0"]
trusted_hash = "sha256:aa"
trusted_content_hash = "sha256:bb"

[hooks.state."phi-router@phi-router:hooks/codex.json:user_prompt_submit:0:0"]
trusted_hash = "sha256:cc"
trusted_content_hash = "sha256:bb"

[hooks.state."phi-router@phi-router:hooks/codex.json:user_prompt_submit:0:1"]
trusted_hash = "sha256:dd"
trusted_content_hash = "sha256:bb"

[hooks.state."phi-router@phi-router:hooks/codex.json:stop:0:0"]
trusted_hash = "sha256:ee"
trusted_content_hash = "sha256:bb"

[hooks.state."phi-router@phi-router:hooks/codex.json:user_prompt_submit:0:2"]
trusted_hash = "sha256:ff"
trusted_content_hash = "sha256:bb"

[hooks.state."phi-router@phi-router:hooks/codex.json:pre_compact:0:0"]
trusted_hash = "sha256:ab"
trusted_content_hash = "sha256:bb"
`;

/**
 * The arguments of each `codex` command with the flag that names `dir` as Codex's home.
 *
 * @param {string} dir The folder.
 * @returns {object} The arguments of `on codex`, `off codex` and `doctor codex`.
 */
const codexIn = (dir: string): Readonly<Record<"on" | "off" | "doctor", readonly string[]>> => ({
	doctor: ["doctor", "codex", "--codex-home", dir],
	off: ["off", "codex", "--codex-home", dir],
	on: ["on", "codex", "--codex-home", dir],
});

const configFile = (dir: string): string => `${dir}/config.toml`;

const roleFile = (dir: string): string => `${dir}/agents/phi-sealed.toml`;

const dotenvFile = (dir: string): string => `${dir}/.env`;

/** A fresh Codex home, and an environment whose HOME is another fresh folder and that sets no Codex home. */
const codexFolders = Effect.gen(function* codexFolders() {
	const home = yield* folder("phi-codex-home-");
	const dir = yield* folder("phi-codex-config-");

	return { dir, env: { CODEX_HOME: "", HOME: home } };
});

/** Writes `text` as `config.toml` in `dir`. */
const settle = Effect.fnUntraced(function* settle(dir: string, text: string) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.writeFileString(configFile(dir), text);
});

export { codexFolders, codexIn, configFile, dotenvFile, enabled, exemptionLine, roleFile, settle, trusted, written };
