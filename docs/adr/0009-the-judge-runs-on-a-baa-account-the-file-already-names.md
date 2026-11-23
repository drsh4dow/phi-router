# The judge runs on a BAA account the file already names

The router picks the judge from `config.json` once, when it starts:

1. A `judge` block: OpenAI Decisions at its endpoint, with its own key, as before.
2. Else the first OpenAI API-key account on `sealed`: Decisions at that account's endpoint, with its key.
3. Else the first Anthropic account on `sealed` that holds its own credential, an API key, a key command, an OAuth token or a login folder: the Claude judge, on the Messages API, with that account's credential.
4. Else the router refuses the file: `config.json names no judge, and sealed holds no account the judge can run on.`

A forwarded account holds no credential of its own, and an OpenAI login folder reaches no Decisions API, so neither can carry the judge. Nor can an Anthropic account whose `lacks` names the Claude judge's model.

We chose this because a Claude Code user whose BAA is with Anthropic needed an OpenAI account under a second BAA only for the judge. The sealed lane already holds a BAA account and its credential, so the judge reuses it and the file needs no second key.

## The Claude judge

Each question is one `POST /v1/messages` through the account, the way a sealed request reaches it. The answer is a forced tool call: `identifier` takes a probability from 0 to 1, and `kind` takes one of the policy's kinds. The first system block is Claude Code's identity line, because a subscription login answers the Messages API only behind it: without it the API answered 429, and with it 200. An API key drops the login's `anthropic-beta` flag, as on the sealed lane. A refusal fails the call as `judge-refused`. An answer cut off, a call to the other tool, a probability outside 0 to 1, or a kind the question does not list fails it as `judge-error`. The engine seals the piece in each case, as it does for Decisions.

## Calibration

The model is `claude-haiku-5-5`, the cheapest current Claude model: $0.10 per million input tokens and $0.50 per million output tokens up to 100,000 input tokens, $0.50 and $2.50 above. It held the leak bar, so no larger model was tried.

One paid run of `bun run eval:live --claude --record` on the default seed asked the kind question about every piece (`clearBelow` 0, `sealAtOrAbove` 0.5): `in-policy positive cases 282: leaked 0`, 5,162 judge calls, $2.5451. The recorded answers were then replayed at other thresholds for free:

| `clearBelow` | Leaked | Over-routed clean cases (of 352) |
| ------------ | ------ | -------------------------------- |
| 0            | 0      | 42                               |
| 0.03         | 0      | 42                               |
| 0.05         | 0      | 41                               |
| 0.06         | 0      | 39                               |
| 0.1          | 3      | 38                               |
| 0.2          | 10     | 31                               |
| 0.3          | 11     | 23                               |

Haiku's identifier scores fall in clusters, at 0.02 (560 answers), 0.05 (183), 0.08 (20) and 0.1 (51). The pieces that leak above 0.06 score 0.08, and the kind question catches them. We chose `clearBelow` 0.05 and `sealAtOrAbove` 0.5: the 0.05 cluster still gets the kind question, one cluster below the one that leaks. The Decisions thresholds, `clearBelow` 0.2, leak 10 cases with this model. A replay at a higher `clearBelow` clears pieces that the live run sealed, so later pieces see other context and some calls have no recording. Those calls seal, which makes the leak counts above 0.06 lower bounds.

`tools/corpus/recordings-claude.jsonl` holds the calls a run at the chosen thresholds asks. 5 calls the clear-0 run never asked were asked live to complete it. A replay at the chosen thresholds prints `leaked 0`, 41 over-routed clean cases (Decisions: 41), 3,494 judge calls, and $1.9549 a run (Decisions: $0.6132). Of the 1,830 recorded calls, six read over 100,000 tokens and cost $1.01 of their $1.57, at the higher price.

## Considered options

- Copy the Decisions thresholds. Rejected: the replay leaks 10 cases at `clearBelow` 0.2.
- Strict tool use, which holds `kind` to the listed choices. Not taken: the calibration ran without it. Haiku sometimes names a kind off the list, such as `phone`, and that call seals as `judge-error`. A choice forced onto the list could land on `none` and clear.
- Keep a separate judge key for Anthropic. Rejected: the sealed account already holds a credential under the same BAA.

## Consequences

- The policy version hashes the judge's name, model and its own thresholds. Changing the judge judges every stored verdict again.
- The Claude judge's calls count against the BAA account's usage and rate limits, beside its sealed requests.
- The judge is built once at start (ADR 0008). Adding a BAA account the judge would pick needs a restart.
- `corpus.test.ts` replays both judges' recordings, and `bun run eval:live --claude` asks the Claude judge on the first Anthropic account on `sealed`.
