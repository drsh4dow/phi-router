# phi-router

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed with `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels, used as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Check

`bun run check` runs every gate and the unit tests. The tests include `tools/corpus/corpus-decisions.test.ts`, which plays the default corpus through lane choice and the border with the recorded judge and fails on a leak or an unrecorded judge call; `bun run eval:recorded` prints the replay's full report. It passes before you hand back a change. The pre-commit hook in `.githooks`, which `bun install` turns on, checks the format and lint of the staged files.

`check` leaves out two suites that CI runs on every pull request. `bun run test:e2e` runs each `*.e2e.test.ts`, a test that builds the plugin or starts a process; it takes minutes. `bun run test:perf` runs each `*.perf.test.ts`, a test that times code on the wall clock. Run the tests a change touches while you work, and each suite once at the head you hand back, or let CI run it.

`check` leaves out the TLA+ models in `tools/formal`. Run `bun run model` too when a change touches a `.tla` or `.cfg` file, or a file in the coverage table of `.agents/skills/verify-formal-model/SKILL.md`. CI runs it on such a pull request and on every push to main.

Read `CODING_STANDARDS.md` before you write or review code in `src/` or `tools/`, or change a gate's config.

## Learning more about Effect

This repository uses the Effect TypeScript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect APIs and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
