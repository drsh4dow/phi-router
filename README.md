# phi-router

phi-router lets you run Claude Code, Codex or pi on a flat-rate subscription when your work touches patient data, without that subscription ever reading PHI.

## What it does

phi-router is a local router. Your harness sends every model request to it, and it reads what is new in each one.

- Your agent runs on your subscription, the open account outside any BAA. A message that holds PHI, such as a tool result with patient names, reaches the subscription as a short handle like `[sealed h3]`, and phi-router keeps the message on your machine.
- Rules catch the unambiguous identifiers, such as an SSN. A judge model under your BAA decides the rest.
- When the work needs a sealed message read, your agent hands a scoped task that names its handle to the pinned subagent `phi-sealed`, which runs on your BAA account. phi-router checks the subagent's answer before your agent reads it. An answer that still holds PHI goes back to the subagent with the reason, up to five times, and then your agent gets a handle instead. Patient identifiers you need in the result go to a private file on your machine, and the answer gives its path.
- Claude Code and [pi-harness](https://github.com/drsh4dow/pi-harness) run this flow. Codex and stock pi need a subagent system you set up, as [SETUP.md](SETUP.md) says. A session on the model `phi/sealed` runs wholly on the BAA account.
- `/phi` shows the session's accounts, how many messages were sealed and cleared, and the pinned subagent's runs and rewrites. In Codex, type it without the slash. In Claude Code the status line shows the same counts while a phi model is picked.
- You can list several subscriptions. A rate limit on one moves the request to the next, and when all of them fail it runs on the BAA account, still with handles in place of PHI. A request never moves from the BAA account to a subscription. At the end of a turn that ran on the BAA account this way, phi-router says why and how to add another subscription, and `/phi` shows when a rate-limited subscription is back.
- The router runs only while a session of your harness runs, and installs no system service. When it is down, requests fail instead of leaving unchecked.

## Get started

You need a coding agent (Claude Code, Codex or pi) logged in to your subscription, and Node or Bun. On an API key alone there is nothing to protect, and setup says so. You also need an OpenAI API key under your organization's BAA for the PHI check, and for Claude Code or pi an Anthropic API key or a Claude Enterprise login under the same BAA. Setup finds what your machine already has and asks only for the rest.

Paste this into your coding agent:

```text
Install phi-router for your harness by following its SETUP.md in https://github.com/drsh4dow/phi-router/blob/main/SETUP.md
```

Claude Code sets it up in the same window, and you paste any key it needs in the plugin's masked field. pi sets it up in the same window, and you type any key it needs in a masked field. Codex sets it up in the chat, and you type any key it needs in a terminal. Or run it yourself, with `codex` or `pi` in place of `claude`:

```sh
npx phi-router setup claude
```

By hand in pi, run `pi install npm:phi-router`, then type `/reload` and `/phi setup`.

New releases arrive by themselves in Claude Code and Codex, from phi-router's release channel, and load in the next session. The router your open windows share keeps the version it started with until you close them all, and a new window says so when a newer one waits. pi tells you when one is out, and `pi update --extensions` takes it. To update now in any of them, run `npx phi-router@latest setup claude`, with `codex` or `pi` in place of `claude`. It keeps your accounts and asks nothing it already knows.

phi-router checks each message for patient data before it is sent. The check runs on OpenAI Decisions under your BAA. Messages it flags, or cannot clear, reach your subscription only as handles, and only your BAA account reads them. Everything else goes to your subscription as before. Setup asks which account your BAA covers and, on a first run, whether to add another subscription. To add one later, run `npx phi-router accounts add`. For a Claude Enterprise login or a key in a password manager, see [Accounts](docs/accounts.md).

## Disclaimer

This software comes with no warranty. The author takes no responsibility for how you use it, including with policies other than the one it ships.
