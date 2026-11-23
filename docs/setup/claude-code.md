# Install phi-router in Claude Code

Start from [SETUP.md](../../SETUP.md). You need its `<checkout>` and the judge's endpoint, model and key source. When `CLAUDE_CONFIG_DIR` is set in your shell, keep it set for every command on this page. Claude Code's user settings are `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`.

Or hand the human one command to run in a terminal of their own, never in this chat: `<checkout>/plugins/claude/bin/phi-router setup claude --source <checkout>`. It asks at hidden prompts for the BAA account's Anthropic API key and the judge's OpenAI key, checks each with its vendor, saves them in files only the human can read, writes `config.json`, installs the plugin, tests it with a fake patient record, turns it on, and starts Claude Code. The steps below do the same by hand.

1. Install the plugin. It starts the router with each session, answers `/phi`, and ships the pinned subagent `phi-router:phi-sealed`. The two commands write `extraKnownMarketplaces.phi-router`, naming the checkout, and `enabledPlugins."phi-router@phi-router"` into the user settings.

   ```sh
   claude plugin marketplace add <checkout>
   claude plugin install phi-router@phi-router --scope user
   ```

2. **Hand-off.** Ask the human about accounts:

   > Claude Code sends its own login to phi-router with every request. Is that login a subscription outside any BAA, or a Claude Enterprise login whose organization has a BAA?
   >
   > phi-router needs an account for the other lane. If your Claude Code login is the subscription, the other is a BAA account: an Anthropic API key from an organization with a BAA, as a command that prints it, or a folder where a Claude Enterprise login lives. If your Claude Code login is the Enterprise one, the other is a subscription: a folder you logged in to with `CLAUDE_CONFIG_DIR=<folder> claude auth login`, or a command that prints a token from `claude setup-token`.
   >
   > Which model should `phi/auto` run, such as `claude-opus-5-5`? And do you want one more subscription on the open lane, beyond these two accounts?

3. Write `config.json` as [SETUP.md](../../SETUP.md#write-configjson) says. Put the subscription in `clean` and the BAA account in `sealed`. For the human who sends a subscription and keeps an API key under the BAA, it is:

   ```json
   {
   	"judge": {
   		"endpoint": "https://api.openai.com/v1",
   		"model": "gpt-6-luna",
   		"keyCommand": "<prints the judge key>"
   	},
   	"clean": [{ "name": "claude-code", "vendor": "anthropic", "forwarded": true }],
   	"sealed": [
   		{ "name": "anthropic-baa", "vendor": "anthropic", "scheme": "apiKey", "keyCommand": "<prints the BAA key>" }
   	],
   	"targetModel": { "anthropic": "<model>" }
   }
   ```

4. When the human wants another subscription, add it. **Hand-off.** Ask the human to log in to it in a new folder with `CLAUDE_CONFIG_DIR=<folder> claude auth login`, or to run `claude setup-token` and keep the token where a command prints it, and to tell you the folder or the command. Then run one of these:

   ```sh
   phi-router accounts add <folder>
   phi-router accounts add --command '<prints the token>'
   ```

   It names the account itself and prints its name and the lane `clean`. A running router serves it from its next request.

5. Run `phi-router on claude`. It writes these settings into the `env` block of the user settings and prints each with its reason:

   | Setting                                     | Value                      | Reason                                                                                                                                                                                                                 |
   | ------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `ANTHROPIC_BASE_URL`                        | `http://127.0.0.1:47411`   | Claude Code sends every model request to the router.                                                                                                                                                                   |
   | `ANTHROPIC_CUSTOM_MODEL_OPTION`             | `phi/auto`                 | Adds `phi/auto` to the `/model` picker.                                                                                                                                                                                |
   | `ANTHROPIC_CUSTOM_MODEL_OPTION_NAME`        | `PHI auto`                 | Names `phi/auto` in the picker.                                                                                                                                                                                        |
   | `ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION` | a short description        | Describes `phi/auto` in the picker.                                                                                                                                                                                    |
   | `CLAUDE_CODE_GATEWAY_HINT_HEADERS`          | `1`                        | Claude Code names each request's class, so the router tells a subagent from the main loop.                                                                                                                             |
   | `DISABLE_FEEDBACK_COMMAND`                  | `1`                        | `/feedback` would send the conversation to Anthropic past the router.                                                                                                                                                  |
   | `DISABLE_TELEMETRY`                         | `1`                        | Telemetry would go to Anthropic past the router.                                                                                                                                                                       |
   | `DISABLE_ERROR_REPORTING`                   | `1`                        | Error reports would go to a third party past the router.                                                                                                                                                               |
   | `no_proxy`                                  | your list, then the router | Claude Code reaches the router without a proxy, which would see every prompt. Written unless the human's `no_proxy` already names the router. Claude Code then reads `no_proxy` from its settings, not from the shell. |

   Beside `no_proxy` it writes `PHI_ROUTER_WROTE_no_proxy`, and `PHI_ROUTER_REPLACED_no_proxy` when it replaced a value. `phi-router off claude` reads them to give `no_proxy` back as it was.

   When you are Claude Code yourself on these same settings, `CLAUDECODE=1` in your shell, this step and the next one are a **Hand-off**. Claude Code reloads `ANTHROPIC_BASE_URL` at once, so your next request would go to a router that no session started. Give the human your report from step 6 now, with the settings in the table above as what `on claude` will write, and ask them to run `phi-router on claude` and then `phi-router doctor claude` in a terminal, by the full path.

6. Run `phi-router doctor claude`. It checks the settings and the plugin, then runs `claude -p` once through the router with a synthetic canary, against mock accounts on loopback. It calls no real account. It exits 0 when every line says `pass`. On a `FAIL` line, do what its last line says, and hand any login, key or trust to the human. When the same line fails twice, stop and show the human the output.

   Once it exits 0, tell the human what you wrote: the plugin entries from step 1, each setting `phi-router on claude` printed with its reason, and the path of `config.json` with the accounts it names. Tell them to restart each open Claude Code session and pick `phi/auto` in `/model`. `/phi` shows the session's accounts and counts, and `/phi pin`, picked from the slash menu, keeps the session on the BAA account. `phi-router off claude` removes the settings.
