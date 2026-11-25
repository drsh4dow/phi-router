# The judge runs only on a System One model

The judge runs only on a System One model, as GLOSSARY.md defines it, and OpenAI Decisions is the one phi-router offers. The router picks it from `config.json` once, when it starts:

1. A `judge` block: Decisions at its endpoint, with its own key, from `keyFile`, `keyCommand` or `keyEnv`.
2. Else the first OpenAI API-key account on `sealed`: Decisions at that account's endpoint, with its key.
3. Else the router refuses the file: `config.json names no judge, and sealed holds no OpenAI API-key account. The judge runs on OpenAI Decisions, so it needs an OpenAI API key under your BAA. Run phi-router setup.`

The `judge` block names no model. A block with a `model` field is refused, and the error names the field. Decisions runs one model, `gpt-6-luna`, at the thresholds it was calibrated on: `clearBelow` 0.2 and `sealAtOrAbove` 0.5.

This supersedes ADR 0009. The Claude judge, `claude-haiku-5-5` on an Anthropic account on `sealed`, is gone with its thresholds and its recordings.

We chose this because the owner ruled it: "we only offer system one models as judge", and "only openai decisions now, drop the local system one judge for now." The judge asks two typed questions, a probability and a kind from a list, and a System One model answers them as typed values. Claude Haiku generates text. It answered through a forced tool call and could name a kind off the list (ADR 0009).

## Considered options

- Keep the Claude judge for a user whose only BAA is with Anthropic. Rejected by the ruling. That user now needs an OpenAI API key under a BAA for the judge, and setup asks for one.
- A local System One model. Left out for now, by the same ruling.
- Azure OpenAI, Cloudflare's Clef and TypeSafe AI's Jev. Out of scope.
- Keep `model` in the `judge` block. Rejected: with one model offered, the field could only name a model the thresholds were not calibrated on.

## Consequences

- A file that ran the Claude judge, with an Anthropic account that holds its own credential on `sealed` and no OpenAI API key, stops the router after the upgrade. `phi-router serve` exits with the line above, and the harness shows the line that names `npx phi-router setup <harness>`. Nothing leaves until the user runs setup again.
- The policy version did not move. It hashes the same Decisions model and thresholds as before, so a stored Decisions verdict still counts.
- Changing the judge's model is a code change, and it judges every stored verdict again.
- `tools/corpus/corpus-decisions.test.ts` and `bun run eval:recorded` replay the one judge's recordings, `tools/corpus/recordings.jsonl`.
