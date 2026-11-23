# Install phi-router in Codex

Start from [SETUP.md](../../SETUP.md). You need its `<checkout>` and the judge's endpoint, model and key source. When `CODEX_HOME` is set in your shell, keep it set for every command on this page. Codex's configuration is `~/.codex/config.toml`, or `$CODEX_HOME/config.toml`.

Or hand the human one command to run in a terminal of their own, never in this chat: `<checkout>/plugins/claude/bin/phi-router setup codex --source <checkout>`. It asks at a hidden prompt for the BAA account's OpenAI API key, which also serves the judge, checks it with OpenAI, saves it in a file only the human can read, writes `config.json`, installs the plugin, tests it with a fake patient record, turns it on, and starts Codex. The steps below do the same by hand.

1. Add the plugin. Its hooks start the router with each session and answer `phi`, `phi pin` and `phi unpin`. The two commands write `[marketplaces.phi-router]`, naming the checkout, and `[plugins."phi-router@phi-router"]` into `config.toml`.

   ```sh
   codex plugin marketplace add <checkout>
   codex plugin add phi-router@phi-router
   ```

2. **Hand-off.** Ask the human about accounts:

   > Codex sends its ChatGPT login to phi-router, which uses it as your open account. phi-router needs an OpenAI API key from an organization with a BAA for the sealed lane. It may be the judge's key. How does it get that key: a command that prints it, or the name of an environment variable that holds it?
   >
   > Which model should `phi/auto` run, such as `gpt-6-luna`? And do you want one more ChatGPT account on the open lane, beyond your Codex login?

3. Write `config.json` as [SETUP.md](../../SETUP.md#write-configjson) says:

   ```json
   {
   	"judge": {
   		"endpoint": "https://api.openai.com/v1",
   		"model": "gpt-6-luna",
   		"keyCommand": "<prints the judge key>"
   	},
   	"clean": [{ "name": "codex", "vendor": "openai", "forwarded": true }],
   	"sealed": [
   		{ "name": "openai-baa", "vendor": "openai", "scheme": "apiKey", "keyCommand": "<prints the BAA key>" }
   	],
   	"targetModel": { "openai": "<model>" }
   }
   ```

4. When the human wants another ChatGPT account, add it. **Hand-off.** Ask the human to log in to it in a new folder with `CODEX_HOME=<folder> codex login`, and to tell you the folder. Then run:

   ```sh
   phi-router accounts add <folder>
   ```

   It names the account itself and prints its name and the lane `clean`. A running router serves it from its next request.

5. Run `phi-router on codex`. It writes these settings into `config.toml`, keeps every other line, and prints each with its reason:

   | Setting                                      | Value                         | Reason                                                                                      |
   | -------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
   | `model_provider`                             | `"phi"`                       | Codex sends every model request to the router, whatever model it names.                     |
   | `model_providers.phi.base_url`               | `"http://127.0.0.1:47411/v1"` | The router's address.                                                                       |
   | `model_providers.phi.name`                   | `"phi-router"`                | Names the router in `/status`.                                                              |
   | `model_providers.phi.wire_api`               | `"responses"`                 | The router speaks the Responses API.                                                        |
   | `model_providers.phi.requires_openai_auth`   | `true`                        | Codex forwards its ChatGPT login, which the router passes only to an open account.          |
   | `model_providers.phi.request_max_retries`    | `2`                           | A request the router refuses fails after two retries.                                       |
   | `model_providers.phi.stream_max_retries`     | `2`                           | A reply stream that breaks fails after two retries.                                         |
   | `features.unbounded_connection_retries`      | `false`                       | With no router up, a prompt ends in a connection error instead of waiting forever.          |
   | `feedback.enabled`                           | `false`                       | `/feedback` would upload logs and the transcript to OpenAI outside the router.              |
   | `experimental_realtime_ws_base_url`          | the router's address          | `/voice` connects to the router, which refuses it, so speech never reaches OpenAI directly. |
   | `experimental_realtime_webrtc_call_base_url` | the router's address          | `/voice` sets up its call through the router too.                                           |

   It also writes two files beside `config.toml`:
   - A last line in `.env`, `NO_PROXY="${NO_PROXY},${no_proxy},127.0.0.1"`, so Codex reaches the router without the human's proxy, which would see every prompt. The human's own lists come first.
   - `agents/phi-sealed.toml`, the role of the pinned subagent `phi-sealed`, since a plugin cannot ship a role.

6. **Hand-off.** Ask the human to trust the plugin's hooks:

   > Start `codex`, pick "Trust all and continue" at "Hooks need review", then quit Codex and tell me. Until you do, no hook starts the router and every prompt ends in a connection error. A plugin update asks again.

   Codex records the trust under `[hooks.state]` in `config.toml`.

7. Run `phi-router doctor codex`. It checks the settings, the plugin and the trust of its hooks, then runs `codex exec` once through the router with a synthetic canary, against mock accounts on loopback. It calls no real account. It exits 0 when every line says `pass`. On a `FAIL` line, do what its last line says, and hand any login, key or trust to the human. When the same line fails twice, stop and show the human the output.

   Once it exits 0, tell the human what you wrote: the plugin entries from step 1, each setting `phi-router on codex` printed with its reason, the `.env` line, the role file, and the path of `config.json` with the accounts it names. Tell them to restart each open Codex session with `codex -m phi/auto`, since `/model` may not list `phi/auto`. Every request goes through the router whatever model they pick. Typing `phi` shows the session's accounts and counts, and `phi pin` keeps the session on the BAA account. `phi-router off codex` removes what `on` wrote.
