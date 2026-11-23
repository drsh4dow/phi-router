# Install phi-router in pi

Start from [SETUP.md](../../SETUP.md). You need its `<checkout>` and the judge's endpoint, model and key source. When `PI_CODING_AGENT_DIR` is set in your shell, keep it set for every command on this page.

1. Install the package. It adds the provider `phi` with the models `phi/auto`, `phi/sealed` and `phi/<id>` for each Anthropic model of pi's catalog, which runs `<id>` through the router, starts the router with each session, and answers `/phi`. The command writes one setting, the checkout's path in the `packages` list of `~/.pi/agent/settings.json`, or `$PI_CODING_AGENT_DIR/settings.json`.

   ```sh
   pi install <checkout>
   ```

2. **Hand-off.** Ask the human about accounts:

   > pi sends its own Anthropic login to phi-router, from `/login` in pi or `ANTHROPIC_API_KEY`. Is that login a subscription outside any BAA, or a Claude Enterprise login whose organization has a BAA?
   >
   > phi-router needs an account for the other lane. If your pi login is the subscription, the other is a BAA account: an Anthropic API key from an organization with a BAA, as a command that prints it, or a folder where a Claude Enterprise login lives. If your pi login is the Enterprise one, the other is a subscription: a folder you logged in to with `CLAUDE_CONFIG_DIR=<folder> claude auth login`, or a command that prints a token from `claude setup-token`.
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
   	"clean": [{ "name": "pi", "vendor": "anthropic", "forwarded": true }],
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

5. Run `phi-router doctor pi`. It checks that pi installed the package, then runs `pi -p` once through the router with a synthetic canary, against mock accounts on loopback. It calls no real account. It exits 0 when every line says `pass`. On a `FAIL` line, do what its last line says, and hand any login, key or trust to the human. When the same line fails twice, stop and show the human the output.

   Once it exits 0, tell the human what you wrote: the package in pi's `packages` list, and the path of `config.json` with the accounts it names. Tell them to restart each open pi session and pick `phi/auto` in `/model`. The status line names the account and model of the last request, `/phi` shows the session's accounts and counts, and `/phi pin` keeps the session on the BAA account. A switch to another provider's model leaves the router. `pi remove <checkout>` removes the package.
