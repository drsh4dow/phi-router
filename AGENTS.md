# phi-router

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed with `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels, used as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Check

`bun run check` runs every gate and the tests. The tests include `tools/corpus/corpus.test.ts`, which plays the default corpus through lane choice and the border with the recorded judge and fails on a leak or an unrecorded judge call; `bun run eval:recorded` prints that replay's full report. It passes before you hand back a change.

Read `CODING_STANDARDS.md` before you write or review code in `src/` or `tools/`, or change a gate's config.

## Learning more about Effect

This repository uses the Effect TypeScript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect APIs and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
