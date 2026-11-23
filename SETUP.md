# Set up phi-router

You are installing phi-router for the human, in Claude Code, Codex or pi. phi-router is a local router. The harness sends every model request to it. It sends a request whose new content holds PHI to the human's BAA account, and every other request to their open account, a subscription outside any BAA. You are done when `phi-router doctor <harness>` exits 0 and you have told the human every setting you wrote.

## Hand-offs

A step marked **Hand-off** needs the human. Ask the question it gives, wait for the answer, and then go on. Keys and tokens stay with the human. `config.json` names a command that prints a key, or a variable that holds one, and only phi-router runs or reads it.

## Steps

1. Check the prerequisites. Each command prints a version:
   - `bun --version` or `node --version`. The router runs on Bun when it is on `PATH`, and on Node otherwise.
   - `git --version`.
   - `claude --version`, `codex --version` or `pi --version`, for the harness the human named. When they named none, ask which.
2. Clone the repository into a folder the human keeps, such as `~/src/phi-router`. Skip this step when the human already has a checkout.

   ```sh
   git clone https://github.com/drsh4dow/phi-router ~/src/phi-router
   ```

   The harness pages call that folder `<checkout>`. The harness loads phi-router from it, so it stays where it is. `phi-router` on every page is the file `<checkout>/plugins/claude/bin/phi-router`, for all three harnesses. It is not on `PATH`, so run it by that path.

3. **Hand-off.** Ask the human about the judge:

   > phi-router's judge reads each new message to decide whether it holds PHI, so it must run under your BAA. It speaks OpenAI's Decisions API. Which endpoint and model should it use? The defaults are `https://api.openai.com/v1` and `gpt-6-luna`. And how does phi-router get its key: a command that prints it, such as `op read op://vault/openai-baa/key`, or the name of an environment variable that holds it?

4. Open the page of the harness and follow it to its end:
   - [Claude Code](docs/setup/claude-code.md)
   - [Codex](docs/setup/codex.md)
   - [pi](docs/setup/pi.md)

   For a second harness, run step 4 again with its page. Both share one `config.json`.

## Write config.json

The harness page gives the file's content. Write it to `phi-router/config.json` in the XDG config folder: `$XDG_CONFIG_HOME`, else `~/.config` on Linux and `~/Library/Application Support` on macOS. Create the folder when it is missing. Make the folder mode 0700 and the file mode 0600.

`clean` lists the open accounts and `sealed` the BAA accounts, each in the order the router tries them. Each account has a `name` no other account has, a `vendor`, `anthropic` or `openai`, and one credential:

| Credential                                         | Entry                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| The login the harness sends                        | `"forwarded": true`                                                     |
| A folder a vendor CLI logged in to                 | `"loginFolder": "<absolute path>"`                                      |
| A command that prints an API key                   | `"scheme": "apiKey", "keyCommand": "<command>"`                         |
| A command that prints a `claude setup-token` token | `"scheme": "oauth", "keyCommand": "<command>"`, Anthropic only          |
| An environment variable that holds either          | `"keyEnv": "<NAME>"` in place of `keyCommand`, set in the harness shell |

The judge takes its key the same way, by `keyCommand` or `keyEnv`.

When `config.json` already exists, add the page's accounts to its lists, and add the page's vendor to `targetModel` when it is not there yet. Keep everything else. Then run `phi-router accounts`. It lists both lanes, and it fails with the reason when the router would refuse the file.
