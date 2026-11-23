# Accounts

`npx phi-router setup <harness>` sets up two accounts. Your harness's own login, the subscription, is the open account. The API key you paste is the BAA account. The judge, which decides whether a message holds patient data, runs on the BAA account too. This page covers every other way to set up accounts. Each section starts from a finished setup unless it says otherwise.

Setup writes the accounts to `phi-router/config.json` in your config folder: `$XDG_CONFIG_HOME`, else `~/.config` on Linux and `~/Library/Application Support` on macOS. After a Claude Code setup it reads:

```json
{
	"clean": [{ "forwarded": true, "name": "claude-1", "vendor": "anthropic" }],
	"sealed": [
		{
			"keyFile": "<config folder>/phi-router/keys/anthropic",
			"name": "claude-2",
			"scheme": "apiKey",
			"vendor": "anthropic"
		}
	]
}
```

`clean` lists the open accounts and `sealed` the BAA accounts, each in the order the router tries them. The file never holds a key, only where to find one. A running router reads the file again when it changes. It picks the judge only when it starts, so after you change the BAA account, close every session of your harness and start a new one.

## Add a second subscription

When one subscription hits its rate limit, the router sends the request to the next one.

- For a Claude subscription, log in to it in a new folder with `CLAUDE_CONFIG_DIR=<folder> claude auth login`, then run `npx phi-router accounts add <folder>`. Or run `claude setup-token`, keep the token where a command prints it, and run `npx phi-router accounts add --command '<prints the token>'`.
- For a ChatGPT subscription, log in to it in a new folder with `CODEX_HOME=<folder> codex login`, then run `npx phi-router accounts add <folder>`.

The command names the account and prints its name and its lane, `clean`. `npx phi-router accounts` lists both lanes.

## Replace the BAA key

Run `npx phi-router setup claude --new-key`, with `codex` or `pi` in place of `claude`. It asks for a new key, checks it, and saves it over the old one.

## Keep the key in a password manager

In the `sealed` account, replace `keyFile` with `keyCommand`, a command that prints the key:

```json
{
	"keyCommand": "op read op://vault/anthropic-baa/credential",
	"name": "claude-2",
	"scheme": "apiKey",
	"vendor": "anthropic"
}
```

Then delete the key file, `phi-router/keys/anthropic` in your config folder, or `keys/openai` for Codex. A later run of setup asks for a key again and saves it in a file.

## Keep the key in an environment variable

In the `sealed` account, replace `keyFile` with `keyEnv`, the name of the variable, such as `"keyEnv": "ANTHROPIC_BAA_KEY"`. Set the variable in the shell you start your harness from, since the router reads it from there. Then delete the key file, as for a password manager.

## Run another model

`phi/auto` runs `claude-opus-5-5` on Anthropic and `gpt-6.1-sol` on OpenAI. To run another model, add `targetModel` to `config.json`, naming the model for your vendor:

```json
"targetModel": { "anthropic": "<model>" }
```

## Use a Claude Enterprise login

Setup takes only an API key. To use a Claude Enterprise login whose organization has a BAA, in Claude Code or pi, write `config.json` and install phi-router yourself.

1. Log in to the Enterprise account in a folder of its own: `CLAUDE_CONFIG_DIR=<folder> claude auth login`.
2. Write `config.json` with that folder's absolute path. Make its folder mode 0700 and the file mode 0600.

   ```json
   {
   	"clean": [{ "forwarded": true, "name": "subscription", "vendor": "anthropic" }],
   	"sealed": [{ "loginFolder": "<folder>", "name": "enterprise", "vendor": "anthropic" }]
   }
   ```

   `"forwarded": true` is the login your harness sends, your subscription. When your harness is logged in to the Enterprise account instead, log in to your subscription in a second folder the same way, and put `"loginFolder": "<second folder>"` in place of `"forwarded": true`.

3. Run `npx phi-router accounts`. It lists both lanes and says whether each account is ready, or what to run when it is not.
4. Install the release that matches `npm view phi-router version`, turn phi-router on, and test it. The test exits 0 when every line says `pass`.
   - In Claude Code:

      ```sh
      claude plugin install phi-router --marketplace drsh4dow/phi-router@v<version> --scope user
      npx phi-router on claude
      npx phi-router doctor claude
      ```

   - In pi, then start pi with `pi --model phi/auto`:

      ```sh
      pi install npm:phi-router@<version>
      npx phi-router doctor pi
      ```

## Run from a clone

For development, install phi-router from a clone. Bun builds it.

```sh
git clone https://github.com/drsh4dow/phi-router
cd phi-router
bun install --frozen-lockfile
bun run build
plugins/claude/bin/phi-router setup claude --source "$PWD"
```

`--source` installs from the clone instead of a release, with `codex` or `pi` in place of `claude`. Your harness loads phi-router from the clone, so keep the clone where it is. The clone holds no built files, so run `bun run build` after each `git pull`, then run `/reload` in pi.

## What an account can hold

Each account has a `name` no other account has, a `vendor`, `anthropic` or `openai`, and one credential:

| Credential                                         | Entry                                                          |
| -------------------------------------------------- | -------------------------------------------------------------- |
| The login the harness sends                        | `"forwarded": true`                                            |
| A folder a vendor CLI logged in to                 | `"loginFolder": "<absolute path>"`                             |
| A file that holds an API key                       | `"scheme": "apiKey", "keyFile": "<absolute path>"`             |
| A command that prints an API key                   | `"scheme": "apiKey", "keyCommand": "<command>"`                |
| A command that prints a `claude setup-token` token | `"scheme": "oauth", "keyCommand": "<command>"`, Anthropic only |
| An environment variable that holds either          | `"keyEnv": "<NAME>"` in place of `keyCommand`                  |

A vendor needs an account in `clean` and an account in `sealed`, or none in either. The judge runs on the first OpenAI API-key account in `sealed`, else on the first Anthropic account in `sealed` that holds its own credential, so not a forwarded one ([ADR 0009](adr/0009-the-judge-runs-on-a-baa-account-the-file-already-names.md)). A `judge` block runs OpenAI's Decisions API on a key of its own instead: `"judge": { "endpoint": "https://api.openai.com/v1", "keyCommand": "<command>" }`.
