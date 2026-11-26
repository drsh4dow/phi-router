---
name: verify-router
description: "Drive phi-router the way a user does: the real Claude Code, Codex and pi binaries through the router against mock upstreams at no cost, and the one live run on real accounts before a release (judge eval on one seed, the three wire runs, the border tests, a clean and a canary prompt per harness). Use to verify a change to the router, an adapter, the policy or the accounts, as a reviewer, or before a release."
---

# Verify the router

phi-router is a local HTTP router. A harness (Claude Code, Codex or pi) sends its model requests to it, and it sends each request that is not pinned to an open account, with a stub and a handle in place of each part the judge or the rules sealed, and a pinned request to a BAA account. A user never calls the router directly. They run a harness whose base URL points at it. So every check here runs the real harness binary, and observes what reached each upstream, the lane log and the state folder.

Two kinds of run:

| Run          | Spends                     | Who runs it                                             |
| ------------ | -------------------------- | ------------------------------------------------------- |
| Mock runs    | nothing, loopback only     | every reviewer, after any change that drives the router |
| The live run | about $0.62, real accounts | a maintainer before a release, once                     |

CI runs neither. `tools/gates/live-off-ci.test.ts` fails when the workflow or the scripts `bun run check` runs name a live command.

## Launch

From the repository root, once per checkout: `bun install --frozen-lockfile`. Every command below calls the router from source (`bun src/router/main.ts`), except the plugin and pi, which load the bundles `bun run build` writes, `plugins/claude/phi-router.mjs` and `plugins/pi/extension.mjs`. `bun run wire` and `bun run test:e2e` build them first. Run `bun run build` before any other command that loads one, such as `vitest run` on one test file.

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

| Command                                                                                    | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run wire claude`, `bun run wire codex`, `bun run wire pi`                             | The real binary through the router against an open, a BAA and a judge mock, with a `judge` block on the judge mock: a clean prompt goes open, the canary case `h-0051-ssn` and a tool result with a canary reach the open mock as stubs with handles and the BAA mock gets no root-agent request, a follow-up reaches the open mock with the stub, the pinned subagent gets the canary in place of its handle on the BAA mock (Claude Code also after `/compact` and a router restart), Claude Code's answer check clears a clean answer, rewrites a rule hit and a judge seal, gives the root agent the handle after 5 rewrites with one notice, leaves the subagent's 0600 file of identifiers in place, and withholds an answer whose check met no router, a 500 or an unreadable body, in the foreground as the could-not-check line and in the background by blocking its notification, no open body holds a complete canary, the canary lives only in the sealed store, state files are 0600 in 0700, each mock gets only its own credential. Last, the open mock answers 429 for a clean prompt: that turn and the next clean one reach the BAA mock with lane reason `overflow` and stubs with handles in place of sealed parts, the harness shows the overflow notice once with the stamp's HH:MM, and `/phi` (`phi` in Codex) shows the open account rate-limited until then. pi also checks the router's lease and exit. |
| `node_modules/.bin/vitest run tools/route/border.test.ts tools/route/codex-border.test.ts` | The border sends only cleared parts and stubs every other part, for the Anthropic and the Codex wire.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `bun run eval:recorded`                                                                    | The policy and the recorded judge seal every in-policy canary of the default seed. It prints `in-policy positive cases N: leaked 0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `bun run cost <checkout>... [--runs=N]`                                                    | What the BAA account receives in one scripted Claude Code session, the claims query: the root agent reads three files, runs a query whose rows hold member names and member numbers, fixes the query, reruns it and reports. Each checkout given is a built router checkout, such as main in a scratch worktree and this one; the runs alternate between them, 3 each by default. It prints the requests and bytes each mock received, with the median and range, and each request of the first run with its system, tools and messages bytes. It fails when a run does not finish, the open mock receives the rows, or the pinned subagent does not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [recipes.md](recipes.md)                                                                   | The hand drives reviewers kept rebuilding: real `serve`, its exit paths, what each harness shows when phi-router stops a message, the empty-/tmp doctor, the pi TUI in tmux, the recording proxy, hostile paths, setup inside the Claude Code and Codex windows, and the Claude Code status line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The wire run's canary is case h-0051 of the default seed with its member number swapped for the voided SSN `078-05-1120`, and its judge mock seals nothing. Only the SSN rule seals it. So a run with that rule off fails, and names the case: `FAIL no open body holds a complete canary of h-0051-ssn`. `tools/wire/cases.test.ts` fails when the case stops being sealed by that rule alone.

[features/README.md](features/README.md) maps each feature a user meets to the commands that drive it.

To show a guard is load-bearing, break it in a scratch worktree (`git worktree add /tmp/<name> HEAD`), commit it there (pi installs the package from the checkout's git), and run the wire run. It must exit 1 and name the check.

## The live run

`live.sh` runs every live check in order, and runs each step even after an earlier one fails:

1. `bun tools/corpus/eval.ts --judge live`, the judge eval on the default seed against the live judge.
2. `bun run wire pi`, `wire claude`, `wire codex`, offline.
3. The border tests, offline.
4. `bun run wire:accounts pi`, `claude`, `codex`, `pi-harness`, on the real accounts. Each step is a fresh session. The router's account endpoints point at a loopback relay, which forwards each request to the real account and records its lane, whether it held the canary, and the tokens the account billed.
   - `prompts` (pi, claude, codex): the clean prompt `Reply with the single word ok.`, then the same prompt with the voided SSN. The lane log holds two lines, both on the clean lane.
   - `tool result` (claude): the root agent `cat`s `overdue.txt`, which holds the voided SSN, and must name the overdue patient_id. It sees `[sealed hN]` and hands the record to `phi-router:phi-sealed`. Every request but the pinned subagent's ran on an open account, the pinned subagent ran on a BAA account, and the root's answer names `p-4821` and holds no canary.
   - `sealed answer` (claude): the root asks the pinned subagent to quote the claim reference, which is the SSN. The answer check rewrites it at least once (`phi-router status` pinned rewrites ≥ 1), and the root's answer holds no canary.
   - `sealed answer in auto mode` (claude): the same with `--permission-mode auto`, where the subagent hands back through `SubagentHandback`. The step sets `CLAUDE_CODE_AUTO_MODE_SERVER=0`, so Claude Code's safety classifier runs through the router on the open account, not on Anthropic's server, which the fake login cannot reach. It passes when no root answer holds the canary, and prints the rewrite count and what the root received: the cleared answer, phi-router's withheld reply, or Claude Code's own fallback.
   - `tool result through pi-harness`: the `tool result` task through pi-harness, whose root hands the record to a `phi/sealed` delegate. Set `PHI_PI_HARNESS` to a pi-harness checkout; the step fails without it.
   - Every step: no request to an open account held the canary, the relay carried every request the lane log holds, no state file but the sealed store holds the canary, and `tools/wire/spent.ts` prices every request a BAA account answered.

It ends with the leaks, the wall time and the cost, and `verify-router live: pass` only when every step exits 0, nothing leaked, and the run took under 20 minutes and under $2.

`bun tools/wire/accounts.ts <harness> --mocked` runs the same steps against scripted mocks, at no cost, inside `unshare -rn`. Auto mode gets as far as the mock allows: the mock answers Claude Code's classifier as harmless, so the hand-back runs through the router's checks, but the classifier's real verdict needs the live run.

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

Run it with an allowlisted environment, so nothing of the caller's reaches the router: `env -i HOME=<scratch> PATH=<bun, node, claude, codex, pi, jq> XDG_CONFIG_HOME=<config> XDG_STATE_HOME=<scratch> XDG_RUNTIME_DIR=<runtime folder> PHI_BUN=<bun> PHI_PI_HARNESS=<pi-harness checkout> sh .agents/skills/verify-router/live.sh <evidence>`. The pinned subagent runs on the config's `sealedModel`, or on `targetModel` when it names none, so `tools/wire/spent.ts` must price that model.

Cost. The judge cost is the router's own, from the lane log and the eval's report. The BAA cost is each request's tokens, as the BAA account reported them to the relay, at the prices in `tools/wire/spent.ts`. A subscription or login-folder request on the open lane counts as $0. A BAA model with no price there fails the run; add its price from pi's model catalog.

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
- The wire runs start each harness with `TZ=UTC`, so the notice's HH:MM is the stamp's UTC time in `accounts.json`.

## Keep it honest

When a drive shows that a step, a command or the feature map no longer matches the router, fix this skill in the same change, or run the **maintain-verification-skill** skill.
