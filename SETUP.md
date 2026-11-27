# Set up phi-router

You are a coding agent, and the human asked you to install phi-router. Name your harness. In Claude Code, follow [Claude Code](#claude-code). In Codex, follow [Codex](#codex). In pi, follow [pi](#pi). In any other harness, reply that phi-router works only in Claude Code, Codex and pi, and end your turn.

In Claude Code and Codex, phi-router updates by itself once installed. When the human asks to update it now, follow the same section with `npx phi-router@latest` where it says `npx phi-router`. In pi, run `pi install npm:phi-router`, then `pi update npm:phi-router`, and tell the human to type `/reload`.

## Claude Code

Setup runs in this window. A key must never enter this chat, because the chat goes to the human's subscription. So the human pastes keys in the plugin's masked field, which you cannot see. Say only the lines below, word for word, and nothing else.

1. Say "Checking what you have. Keys never show up here." Then run `npx phi-router setup claude --json`.
2. It prints one JSON step. Act on its `kind`:
   - `ask`: ask `question.text` with AskUserQuestion, one option per label in `question.choices`. Then run the command again with `--answers '<json>'`, where the JSON maps each question's `id` to the `id` of the choice picked so far, such as `--answers '{"baa":"key"}'`. Repeat step 2.
   - `stop`: say its `line` and end your turn.
   - `ready`: run `npx phi-router setup claude --apply --answers '<json>'` with the same JSON, and a 10-minute timeout, because a sign-in waits for the browser.
3. Say the last line the apply step printed. When it asks the human to paste keys or to sign in, end your turn, and when they say done, run step 2's `--apply` command again.

On Windows, phi-router runs without WSL. It needs Git for Windows, because the plugin's hooks run in Git Bash, and Claude Code 2.1.214 or later. Run these commands with the Bash tool, not PowerShell, which strips the quotes inside `--answers`. If you have no Bash tool, Git for Windows is missing: tell the human to install it from https://git-scm.com/downloads/win and restart Claude Code, and end your turn.

If `npx` is not found, type `bunx` instead. If the human pastes a key in this chat, do not repeat it, use it, or write it anywhere. Tell them the key went to their subscription's vendor with this chat, so they must revoke it where they got it and paste a new one in `/plugin configure phi-router`. If they ask for something else, such as a second subscription, a key in a password manager, or another model, point them to its section in [Accounts](https://github.com/drsh4dow/phi-router/blob/main/docs/accounts.md).

## Codex

Setup runs in this window. A key must never enter this chat, because the chat goes to the human's subscription and Codex keeps what they type in its history. So the human types a key at a hidden prompt in a terminal. Say only the lines below, word for word, and nothing else.

1. Say "Checking what you have. Keys never show up here." Then run `npx phi-router setup codex --json`. Run every setup command outside the sandbox, with the prefix rule `["npx", "phi-router", "setup", "codex"]`, because setup writes Codex's settings and checks keys online.
2. It prints one JSON step. Act on its `kind`:
   - `ask`: say `question.text` and a numbered list of the labels in `question.choices`, and end your turn. When the human picks one, run the command again with `--answers '<json>'`, where the JSON maps each question's `id` to the `id` of the choice picked so far, such as `--answers '{"baa":"env"}'`. Repeat step 2.
   - `stop`: say its `line` and end your turn.
   - `ready`: run the same command with `--apply` in place of `--json`, and wait until it exits.
3. Say the last line the apply step printed, and end your turn.

If `npx` is not found, type `bunx` instead. If the human pastes a key in this chat, do not repeat it, use it, or write it anywhere. Tell them the key went to their subscription's vendor with this chat, so they must revoke it where they got it and type a new one in the terminal command setup names. If they ask for something else, such as a second subscription, a key in a password manager, or another model, point them to its section in [Accounts](https://github.com/drsh4dow/phi-router/blob/main/docs/accounts.md).

When the human asks how to work with PHI in Codex, follow [Work that needs PHI in Codex and stock pi](#work-that-needs-phi-in-codex-and-stock-pi).

## pi

Setup runs in this window, and the human types each key in a masked field that never reaches this chat.

1. Run `pi install npm:phi-router`.
2. Send the message below word for word, and end your turn.

   > phi-router is installed. Type `/reload`, then `/phi setup`. Setup asks which account your BAA covers and takes each key in a masked field, never in this chat. When it ends, this session runs on `phi/auto`.

When the human asks how to work with PHI in pi, follow [Work that needs PHI in Codex and stock pi](#work-that-needs-phi-in-codex-and-stock-pi).

## Work that needs PHI in Codex and stock pi

phi-router keeps the root agent on the subscription and hands work that needs PHI to a pinned subagent on `phi/sealed`, as [How it works](https://github.com/drsh4dow/phi-router#how-it-works) says. Claude Code and [pi-harness](https://github.com/drsh4dow/pi-harness) run all of it. Codex and stock pi need a subagent system, which the human sets up. Tell the human what their harness needs:

- Codex: setup installs the agent role `phi-sealed` on `phi/sealed`, in `agents/phi-sealed.toml` in Codex's folder, and Codex's `spawn_agent` tool starts it. phi-router puts the content behind each handle back for it. phi-router does not check the subagent's answer in Codex, so nothing asks it to rewrite. An answer that holds PHI reaches the root agent as a handle, which the root agent cannot read. Give `phi-sealed` tasks that ask for internal ids, counts, or the path of a local file.
- Stock pi has no subagents. For work that needs PHI, switch the model to `phi/sealed`. The whole session then runs on the BAA account, and nothing checks its replies. Or install a subagent system, such as pi-harness, that starts each delegate as a pi process with the phi-router package, on the model `phi/sealed`, and with the environment variable `PHI_ROUTER_SESSION` set to the root agent's pi session id. In that delegate the phi-router package checks the last answer before the delegate ends, and replaces a withheld answer in the delegate's session. So the subagent system must read the delegate's answer from its session once it ends.
