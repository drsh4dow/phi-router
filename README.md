# phi-router

Run Claude Code, Codex or pi on your flat-rate subscription when your work touches patient data. Only your BAA account reads PHI. [HIPAA-aligned](#what-hipaa-aligned-means).

[![npm](https://img.shields.io/npm/v/phi-router)](https://www.npmjs.com/package/phi-router)
[![check](https://github.com/drsh4dow/phi-router/actions/workflows/check.yml/badge.svg)](https://github.com/drsh4dow/phi-router/actions/workflows/check.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

![Claude Code reads a synthetic patients.csv. The open account gets [sealed h1], the phi-sealed subagent does the work on the BAA account, and Claude Code answers that 2 of 4 patients are overdue.](docs/demo.gif)

The real Claude Code and router against mock accounts. Model replies are scripted, and the patients are synthetic. The bottom pane shows what each account received.

## How it works

![A message goes through phi-router's rules and judge. Sealed parts stay in the sealed store, and cleared parts reach the root agent. When the task needs PHI, the root agent hands a scoped task to the phi/sealed subagent, and phi-router checks its answer before the root agent reads it.](docs/how-it-works.png)

- Your agent runs on your subscription. phi-router reads each new message before it goes out.
- Rules catch identifiers such as SSNs. A judge on your BAA account decides the rest.
- A message with PHI reaches your subscription as a handle, such as `[sealed h3]`.
- When the task needs that PHI, your agent hands a scoped task to the `phi-sealed` subagent on your BAA account. phi-router checks the subagent's answer and sends it back to rewrite, up to five times, until it holds no PHI. Identifiers you need go to a private file on your machine.
- If the router is down, requests fail.

## Get started

You need:

- Claude Code, Codex or pi, logged in to your subscription.
- An OpenAI API key under your BAA, for the judge.
- For Claude Code or pi, an Anthropic API key or a Claude Enterprise login under your BAA.

Paste this into your coding agent:

```text
Install phi-router for your harness by following its SETUP.md in https://github.com/drsh4dow/phi-router/blob/main/SETUP.md
```

Or run it yourself, with `codex` or `pi` in place of `claude`:

```sh
npx phi-router setup claude
```

Setup finds the keys you already have and asks only for the rest. Claude Code and Codex take updates by themselves, and pi tells you when one is out. More in [SETUP.md](SETUP.md) and [Accounts](docs/accounts.md).

## Proof

`bun run eval:recorded` replays a synthetic corpus through the router with the judge's recorded answers. It calls no API.

| Check                               | Result    |
| ----------------------------------- | --------- |
| PHI cases leaked to an open account | 0 of 458  |
| Clean cases sealed anyway           | 42 of 352 |
| Judge cost for 3,951 calls          | $0.9037   |

The corpus covers 20 identifier kinds, such as names, SSNs and MRNs, in 12 formats, such as FHIR, HL7v2, SQL dumps and screenshots. Zero leaks in a sample is not a zero leak rate. For the 99 plain-text cases, the 95% upper bound is 0.0298. `bun run check` replays it on every pull request and fails on any leak.

## What it saves

`bun run cost .` drives the real Claude Code through a scripted claims session against mock accounts. Your subscription took 8 of 9 requests. The BAA account took 1.

| Estimate, input tokens at list price | Everything on the BAA account | With phi-router |
| ------------------------------------ | ----------------------------- | --------------- |
| Per session                          | $0.44                         | $0.04           |
| Per 1,000 sessions                   | $444                          | $41             |

Prices were read on 2026-11-26: [Claude Opus 5.5](https://platform.claude.com/docs/en/about-claude/pricing) at $4 and the [Decisions judge](https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability) at $0.10 per million input tokens. The estimate leaves out output tokens, caching and your subscription fee.

## Compared to the alternatives

|                             | Everything on a BAA API key | Claude Enterprise with HIPAA | A redaction tool such as [Presidio](https://github.com/microsoft/presidio) | phi-router                |
| --------------------------- | --------------------------- | ---------------------------- | -------------------------------------------------------------------------- | ------------------------- |
| Everyday requests run on    | The BAA account, per token  | The Enterprise account       | Your current account                                                       | Your subscription         |
| The agent can work with PHI | Yes                         | Yes                          | No, only redacted text                                                     | Yes, through the subagent |
| When the check can't run    | No check                    | No check                     | Up to your code                                                            | The part stays sealed     |

## What HIPAA-aligned means

phi-router keeps PHI on the accounts your BAA covers. It is not a certification.

phi-router does this:

- PHI that the rules or the judge find reaches only your BAA accounts.
- A part it cannot check stays sealed.
- Sealed content stays in a 0600 file on your machine.

You keep this:

- The BAA with each vendor whose account reads PHI.
- The policy. phi-router's definition of PHI is a routing rule, so check it against yours.
- Your compliance program and the machine phi-router runs on.

## FAQ

**What counts as PHI?** A complete direct identifier of a real patient or member, of 21 kinds, from HIPAA's Safe Harbor list ([ADR 0017](docs/adr/0017-the-policy-names-the-safe-harbor-identifiers.md)): name, SSN, full date of birth, home address, city or ZIP code, personal phone, fax, email and URL, IP address, member number, Medicare or Medicaid number, MRN, account number, driver license, other certificate or license number, passport, vehicle identifier, device serial number, biometric identifier, and face photo. This is not a HIPAA certification. Internal ids, staff contacts, fragments and counts are not.

**What does the judge see?** Each new part no rule sealed, alone, without the conversation ([ADR 0013](docs/adr/0013-the-judge-reads-a-piece-without-context.md)). It runs on OpenAI's Decisions API under your BAA. If it fails to answer, the part stays sealed.

**What does the router not cover?** Before each prompt, your harness checks that the router on its port is yours. A request sent before the first prompt, or after a crash in the middle of a turn, skips that check, so another user on the same machine could read it ([ADR 0002](docs/adr/0002-a-prompt-waits-until-the-router-proves-it-is-yours.md)).

**Does it work with Codex and pi?** Claude Code and [pi-harness](https://github.com/drsh4dow/pi-harness) run the whole flow. Codex runs the subagent without the answer check. Stock pi has no subagents, so use `phi/sealed` for PHI work. See [SETUP.md](SETUP.md#work-that-needs-phi-in-codex-and-stock-pi).

**What if my subscription hits a rate limit?** List several subscriptions and phi-router moves to the next one. When all are limited, the request runs on the BAA account, with handles still in place of PHI. In Claude Code and pi, the status line under the prompt marks the overflow, with the time the router tries your subscription again when it has one, and `/phi` shows the session's accounts and counts. phi-router adds no notice to their conversation. Codex has no status line, so it says so once at the end of the turn.

## Security

Report a vulnerability or a suspected leak privately, as [SECURITY.md](SECURITY.md) says. Never put real PHI in an issue. To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

This software comes with no warranty. The author takes no responsibility for how you use it, including with policies other than the one it ships.
