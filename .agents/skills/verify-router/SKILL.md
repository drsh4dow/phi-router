---
name: verify-router
description: "Drive phi-router the way a user does: the real Claude Code, Codex and pi binaries through the router against mock upstreams at no cost, and the one live run on real accounts before a release (judge eval on one seed, the three wire runs, the border tests, a clean and a canary prompt per harness). Use to verify a change to the router, an adapter, the policy or the accounts, as a reviewer, or before a release."
---

# Verify the router

phi-router is a local HTTP router. A harness (Claude Code, Codex or pi) sends its model requests to it, and it sends each request to an open account or a BAA account by what the judge and the rules say about its content. A user never calls the router directly. They run a harness whose base URL points at it. So every check here runs the real harness binary, and observes what reached each upstream, the lane log and the state folder.

Two kinds of run:

| Run          | Spends                     | Who runs it                                             |
| ------------ | -------------------------- | ------------------------------------------------------- |
| Mock runs    | nothing, loopback only     | every reviewer, after any change that drives the router |
| The live run | about $0.62, real accounts | a maintainer before a release, once                     |

CI runs neither. `tools/gates/live-off-ci.test.ts` fails when the workflow or the scripts `bun run check` runs name a live command.

## Launch

From the repository root, once per checkout: `bun install --frozen-lockfile`. Every command below calls the router from source (`bun src/router/main.ts`), except pi, which loads the bundle `plugins/pi/extension.mjs`. After a change under `src/`, run `bun run build` so pi runs the same code.

Each run starts its own router and its own mocks on free loopback ports, in fresh temp folders, and stops them when it ends. Two runs can go side by side. Never use the host's port 47411, the product port, for a test; the recipes use it only inside their own network namespace.

Run every mock run with no network beyond loopback, so a slip cannot reach a real account:

```sh
unshare -rn sh -c 'ip link set lo up && exec bun run wire claude'
```

## Doctor

Run these first when anything looks off. Each is read-only.

- `bun src/router/main.ts accounts` with `XDG_CONFIG_HOME` set lists each account of the config and whether its credential reads. It prints `ok.` per account and never the credential.
- `bun src/router/main.ts doctor claude --config-dir <folder>`, `doctor codex --codex-home <folder>` and `doctor pi --agent-dir <folder>` check that a harness's own config points at the router.
- `claude --version`, `codex --version` and `pi --version` show the binaries the runs will drive.

## Drive on mocks

Each command exits 0 when everything it checks holds. The wire runs print one `pass` or `FAIL` line per check.

| Command                                                                                    | What it proves                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run wire claude`, `bun run wire codex`, `bun run wire pi`                             | The real binary through the router against an open, a BAA and a judge mock: a clean prompt goes open, the canary case `h-0051-ssn` goes to BAA, a follow-up reaches the open mock with a stub, a tool result with a canary goes to BAA, no open body holds a complete canary, state files are 0600 in 0700, each mock gets only its own credential. pi also checks the router's lease and exit. |
| `node_modules/.bin/vitest run tools/route/border.test.ts tools/route/codex-border.test.ts` | The border sends only cleared parts and stubs every other part, for the Anthropic and the Codex wire.                                                                                                                                                                                                                                                                                           |
| `bun run eval:recorded`                                                                    | The policy and the recorded judge seal every in-policy canary of the default seed. It prints `in-policy positive cases N: leaked 0`.                                                                                                                                                                                                                                                            |
| [recipes.md](recipes.md)                                                                   | The hand drives reviewers kept rebuilding: real `serve`, its exit paths, the empty-/tmp doctor, the pi TUI in tmux, the recording proxy and hostile paths.                                                                                                                                                                                                                                      |

The wire run's canary is case h-0051 of the default seed with its member number swapped for the voided SSN `078-05-1120`, and its judge mock seals nothing. Only the SSN rule seals it. So a run with that rule off fails, and names the case: `FAIL no open body holds a complete canary of h-0051-ssn`. `tools/wire/cases.test.ts` fails when the case stops being sealed by that rule alone.

[features/README.md](features/README.md) maps each feature a user meets to the commands that drive it.

To show a guard is load-bearing, break it in a scratch worktree (`git worktree add /tmp/<name> HEAD`), run `bun run build` there when the change is under `src/`, commit it there (pi installs the package from the checkout's git), and run the wire run. It must exit 1 and name the check.

## The live run

`live.sh` runs every live check in order, and runs each step even after an earlier one fails:

1. `bun tools/corpus/eval.ts --judge live`, the judge eval on the default seed against the live judge.
2. `bun run wire pi`, `wire claude`, `wire codex`, offline.
3. The border tests, offline.
4. `bun run wire:accounts pi`, `claude`, `codex`: per harness, one fresh session with the clean prompt `Reply with the single word ok.` and then the same prompt with the voided SSN, on the real accounts. It checks that the session's lane log holds two lines, the first on the clean lane and the second sealed for its new content, and that no state file holds the canary.

It ends with the leaks, the wall time and the cost, and `verify-router live: pass` only when every step exits 0, nothing leaked, and the run took under 10 minutes and under $2.

```sh
XDG_CONFIG_HOME=<folder with phi-router/config.json> sh .agents/skills/verify-router/live.sh <evidence folder>
```

The account config names the developer's own accounts. The router reads each credential through it; the run never reads, copies or prints one. The harnesses run in throwaway folders with a fake login, so every account must be a login folder or a key command, never `forwarded`. An example config:

```json
{
	"judge": { "endpoint": "https://api.openai.com/v1", "keyCommand": "<command that prints an OpenAI BAA key>" },
	"clean": [
		{
			"name": "claude-setup-token",
			"vendor": "anthropic",
			"scheme": "oauth",
			"keyCommand": "<command that prints a claude setup-token token>"
		},
		{ "name": "chatgpt", "vendor": "openai", "loginFolder": "<Codex login folder>" }
	],
	"sealed": [
		{ "name": "anthropic-baa", "vendor": "anthropic", "loginFolder": "<Claude BAA login folder>" },
		{
			"name": "openai-baa",
			"vendor": "openai",
			"scheme": "apiKey",
			"keyCommand": "<command that prints an OpenAI BAA key>"
		}
	],
	"targetModel": { "anthropic": "claude-haiku-5-5", "openai": "gpt-6-luna" }
}
```

Run it with an allowlisted environment, so nothing of the caller's reaches the router: `env -i HOME=<scratch> PATH=<bun, node, claude, codex, pi, jq> XDG_CONFIG_HOME=<config> XDG_STATE_HOME=<scratch> PHI_BUN=<bun> sh .agents/skills/verify-router/live.sh <evidence>`.

Cost. The judge cost is the router's own, from the lane log and the eval's report. The BAA cost is each sealed request's tokens, as its harness reports them, at the prices in `tools/wire/spent.ts`. A subscription or login-folder request on the open lane counts as $0. A BAA model with no price there fails the run; add its price from pi's model catalog.

A login folder whose token is near its end gets refreshed by its vendor's CLI, in place. For `~/.claude` that CLI run writes `~/.claude/.credentials.json` and can create `~/.claude/.claude.json` and a file under `~/.claude/backups`.

## Evidence

`live.sh` keeps one log per step in the evidence folder (`eval.log`, `wire-<harness>.log` and `.json`, `border.log`, `accounts-<harness>.log`). A wire run's report is the JSON path it prints. Keep the folder; cleanup never removes it. A proof names the step's log and its `pass` lines, or the eval's `leaked` and `cost` lines.

## Cleanup

Each run removes its temp folders and stops the router and mocks it started when it exits. If a run is killed, find what it left with `pgrep -af 'src/router/main.ts serve'` and kill only the pids your run started. Remove its `phi-wire-*`, `phi-router-*` and `phi-accounts-*` folders under the temp folder. Remove a scratch worktree with `git worktree remove --force <path>`.

## Gotchas

- A failed real-account step is never skipped silently. If a harness cannot run on real accounts under these rules, mark the step skipped with the reason in the report.
- The lane log logs model POSTs only. Codex's `/models` GET reaches the open account and is not logged.
- Codex's update prompt starts a global install on Enter. Every Codex home these runs make holds `check_for_update_on_startup = false`.
- Run Codex in a folder outside any git repository; the runs do.
- On a loaded machine the wire runs and some property tests can hit their time limits. Rerun the one that failed, alone.

## Keep it honest

When a drive shows that a step, a command or the feature map no longer matches the router, fix this skill in the same change, or run the **maintain-verification-skill** skill.
