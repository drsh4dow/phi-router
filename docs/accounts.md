# Accounts

`npx phi-router setup <harness>` fills three roles. Everyday work runs on the open account, your harness's own subscription login. Patient data runs on the BAA account, an API key or a Claude Enterprise login. The PHI check, the judge that decides whether a message holds patient data, runs on OpenAI Decisions with an OpenAI API key under your BAA.

Setup reads what the machine already has: your harness's login, a key in `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, a key pi holds, and the key files of an earlier setup. It asks which account your BAA covers and, for each role it could not fill, for a key at a hidden prompt or a login through the vendor's own `claude auth login`. It stops and changes nothing when there is nothing to protect (your harness runs on an API key), when it needs a key you do not have, or when Claude Code runs on Bedrock, Vertex AI, Foundry or a gateway in `ANTHROPIC_BASE_URL`. A second run asks nothing and changes no file. This page covers every other way to set up accounts. Each section starts from a finished setup unless it says otherwise.

Setup writes the accounts to `phi-router/config.json` in your config folder: `$XDG_CONFIG_HOME`, else `~/.config` on Linux and `~/Library/Application Support` on macOS. After a Claude Code setup with two pasted keys it reads:

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
	],
	"judge": { "endpoint": "https://api.openai.com/v1", "keyFile": "<config folder>/phi-router/keys/openai" }
}
```

`clean` lists the open accounts and `sealed` the BAA accounts, each in the order the router tries them. The file never holds a key, only where to find one: a key setup found in your environment stays there, named by `keyEnv`. A running router reads the file again when it changes. It picks the judge only when it starts, so after you change the BAA account, close every session of your harness and start a new one.

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

The `judge` block takes `keyCommand` in place of `keyFile` the same way. Then delete the key file, `phi-router/keys/anthropic` in your config folder, or `keys/openai` for Codex. On Codex the `judge` block names `keys/openai` too, so change it first.

## Keep the key in an environment variable

In the `sealed` account, replace `keyFile` with `keyEnv`, the name of the variable, such as `"keyEnv": "ANTHROPIC_BAA_KEY"`. Set the variable in the shell you start your harness from, since the router reads it from there. Then delete the key file, as for a password manager.

## Run another model

`phi/auto` runs `claude-opus-5-5` on Anthropic and `gpt-6.1-sol` on OpenAI. To run another model, add `targetModel` to `config.json`, naming the model for your vendor:

```json
"targetModel": { "anthropic": "<model>" }
```

## Use a Claude Enterprise login

Setup offers a Claude Enterprise login as the BAA account, in Claude Code and in pi.

- When Claude Code is logged in to Claude Enterprise, setup asks whether your BAA covers it. On yes, the BAA account is Claude Code's own login folder, and setup asks you to log in to the subscription you use for everyday work, in a login folder of its own under `phi-router/logins/` in your config folder.
- When your harness runs on a subscription, pick `Claude Enterprise login` at `Which account does your BAA cover?`. Setup runs `claude auth login` in a login folder of its own.

With a browser, the login opens it. Without one, paste the code the login page shows at `Paste code here if prompted`. Check that your BAA covers Claude Code through phi-router: Anthropic's public page says its BAA does not cover a custom base URL by default.

On macOS, setup does not offer a login it would have to create. Claude Code keeps a login in the Keychain there, and the router reads only a login folder's file.

## Set up without a terminal

A driver with no terminal, such as an agent or pi's `/phi setup`, runs setup in two steps. Neither takes a key as an argument.

- `npx phi-router setup claude --json --answers '<picks>'` prints, as JSON, what setup found and the next question, a stop line, or the keys it still needs. It changes nothing. `<picks>` maps a question's `id` to a choice's `id`, such as `{"baa":"key"}`.
- `npx phi-router setup claude --apply --answers '<picks>'` sets up with those picks. It reads each key it needs from `PHI_ROUTER_ANTHROPIC_KEY` or `PHI_ROUTER_OPENAI_KEY`, else from a hidden prompt when standard input is a terminal.

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

A vendor needs an account in `clean` and an account in `sealed`, or none in either. The judge runs OpenAI's Decisions API on the first OpenAI API-key account in `sealed` ([ADR 0014](adr/0014-the-judge-runs-only-on-a-system-one-model.md)). A `judge` block runs it on a key of its own instead: `"judge": { "endpoint": "https://api.openai.com/v1", "keyCommand": "<command>" }`. With neither, the router does not start.
