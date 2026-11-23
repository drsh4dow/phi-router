# phi-router

phi-router lets you run Claude Code, Codex or pi on a flat-rate subscription when your work touches patient data, without that subscription ever reading PHI.

## What it does

phi-router is a local router. Your harness sends every model request to it, and it reads what is new in each one.

- A request with no PHI runs on your subscription, the open account outside any BAA.
- A request whose new content holds PHI runs on your account under a BAA. Each later request to the subscription carries a constant stub where that content was.
- Rules catch the unambiguous identifiers, such as an SSN. A judge model under your BAA decides the rest.
- `/phi` shows the session's accounts and how many messages were sealed and cleared. `/phi pin` keeps a session on the BAA account, and `/phi unpin` returns it to routing. In Codex, type them without the slash.
- An agent that must work with the PHI itself starts the pinned subagent `phi-sealed`, which runs on the BAA account.
- You can list several subscriptions. A rate limit on one moves the request to the next, and when all of them fail it runs on the BAA account. A request never moves from the BAA account to a subscription.
- The router runs only while a session of your harness runs, and installs no system service. When it is down, requests fail instead of leaving unchecked.

## Get started

You need Claude Code, Codex or pi, Bun, a subscription, and an account under a BAA for the sealed requests and the judge. Tell your coding agent:

> Install phi-router for your harness by following its SETUP.md in https://github.com/drsh4dow/phi-router/blob/main/SETUP.md

It asks you for each login and key it needs, and never reads a key itself. It ends by telling you each setting it wrote. Then start a new session and pick the model `phi/auto`. In Codex, start it with `codex -m phi/auto`.

## Disclaimer

This software comes with no warranty. The author takes no responsibility for how you use it, including with policies other than the one it ships.
