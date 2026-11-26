# Security

## Report a vulnerability or a suspected leak

Open a [private vulnerability report](https://github.com/drsh4dow/phi-router/security/advisories/new). Do not open a public issue for it.

Report it privately when you find any of these:

- A part that the rules or the judge sealed reaches an open account.
- A request reaches an open account without passing the border, such as through a path or a field the router passes on unchecked.
- Another user on the same machine can read the router's traffic, its secret or its state files.
- A key or a login shows up in a chat, a log, or a file other than phi-router's own key files.

When you are not sure, report it privately.

## What to send

Never send real PHI or a real key. Rebuild the problem with synthetic data, such as the voided SSN `078-05-1120` and a made-up name.

- The phi-router version, from `npx phi-router --version`.
- Your harness and its version: Claude Code, Codex or pi.
- Your operating system.
- The steps, with synthetic data only.
- What reached which account. The lane log, `phi-router/lanes.jsonl` in your XDG state folder, holds no content, and `/phi` shows the session's counts.

If real PHI reached an open account, follow your organization's incident process. phi-router cannot recall a request it sent.

## Supported versions

Only the latest release gets fixes. Claude Code and Codex take a new release from the release channel by themselves. In pi, run `pi update --extensions`.
