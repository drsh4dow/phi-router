# Mock-only recipes

The hand drives reviewers kept rebuilding, distilled from their drivers. Each spends nothing: fake tokens, mock accounts, and a network namespace with loopback only. Run them from this folder. Each prints the lines below; the run that proved this file kept its logs.

## Helpers

- `recipes/iso.sh NAME CMD...` runs CMD, a recipe script by its name or any command, in fresh folders. The folders live under `$PHI_VERIFY_SCRATCH/NAME` (default `/tmp/phi-verify-router/NAME`): HOME, every XDG folder, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` with `check_for_update_on_startup = false`, `PI_CODING_AGENT_DIR`, TMPDIR and a working folder. It clears the environment but `PATH`, sets `CANARY=PHI-RECIPE-CANARY-29`, puts `recipes/` first on `PATH`, and runs CMD in `unshare -rn` with `lo` up. `ISO_UNSHARE` replaces the `-rn` flags. The `bun` on `PATH` must be the repository's.
- `recipes/world.ts HARNESS PORT` starts the open, BAA and judge mocks of `tools/route/mocked-router.ts`; the judge seals any piece that holds `$CANARY`. With PORT `0` or a number it also runs the real `serve`, leased to its own pid; with `none` it starts no router. It prints one JSON line `{url, state, env}`. On SIGTERM it prints `{received, canaryAt, lanes}`: requests per mock, whether an open or BAA request held the canary, and the lane log as `lane/account/reason`.

The ports these recipes name, 47411 among them, are inside the namespace, never the host's.

## 1. Real `serve` with the three mocks

The router binds 127.0.0.1 only, refuses another loopback address, answers an unknown path or method with 404, and routes a clean prompt, a canary prompt and its follow-up. Add curl probes here.

```sh
recipes/iso.sh serve serve.sh
```

```
127.0.0.2 refused
clean 200
canary 200
follow-up 200
unknown-path 404
wrong-method 404
{"received":{"open":2,"baa":1,"judge":4},"canaryAt":{"open":false,"baa":true},"lanes":["clean/open/clean","sealed/baa/sealed new content","clean/open/clean"]}
```

## 2. The router's exit paths

`serve` with no lease stops after one lease check; the router stops once the leased pid dies; `start` for a dead pid fails naming it; a missing `config.json` fails `start` after 10 s, and `serve` names the file.

```sh
recipes/iso.sh exits exits.sh
```

```
no lease: serve exited 1 after 5 s
start exited 0
router answers on 47411
lease ended: port closed 5 s after the holder died
dead pid: start exited 1
no config: start exited 1 after 10 s
no config: serve exited 1
```

The times vary with load: 5 to 6 s and 10 to 11 s in three runs, against the 5 s lease interval and `start`'s 10 s wait. The script exits 130, from its last `wait` on the mocks it stops.

### 2b. pi when its router cannot start

```sh
recipes/iso.sh pi-failed-start pi-failed-start.sh
```

```
pi with no config.json exited 1
lines holding the login: 0
```

## 3. The empty-/tmp doctor for Claude Code and Codex

The installed plugin passes `phi-router doctor` from its launcher, with an empty `/tmp`, loopback only, and TMPDIR left empty. The script binds the checkout and its own folder back into the empty `/tmp` when they live there. For Codex it first trusts the plugin's hook through the Codex TUI in tmux. It exits 1 at the first setup step that fails, naming it (`FAIL add the marketplace exited 127`), and otherwise with the doctor's exit code.

```sh
ISO_UNSHARE=-rnm recipes/iso.sh doctor-claude doctor.sh claude
ISO_UNSHARE=-rnm recipes/iso.sh doctor-codex doctor.sh codex
```

```
add the marketplace: ok
install the plugin: ok
phi-router on claude: ok
pass the canary arrived at the BAA mock
pass the canary arrived at no open mock
doctor claude exited 0
TMPDIR holds: 0 entries
```

Codex prints the same lines for `codex exec` and `/tmp after doctor holds:` with nothing after it. `doctor claude` leaves empty folders under `/tmp/cc-socks` and `/tmp/claude-0`, written by its own `claude -p` turn.

## 4. The pi TUI through tmux

The interactive pi with the package picks `phi/auto` through `/model`, answers a clean prompt from the open mock and a canary prompt from the BAA mock, and its router stops once pi exits on Ctrl-C.

```sh
recipes/iso.sh tui tui.sh
```

```
no router before pi
ok replies on screen: 2
router answers on 47411 while pi runs
router down 1 s after pi exited
{"received":{"open":1,"baa":1,"judge":6},"canaryAt":{"open":false,"baa":true},"lanes":["clean/open/clean","sealed/baa/sealed new content"]}
```

The router went down 1 to 4 s after pi exited, in five runs. The script waits up to 10 s for the router while pi runs, and exits 1 with a `FAIL` line when pi shows fewer than two `ok` replies, no router answers while pi runs, the router outlives pi by 15 s, or the canary reaches any mock but the BAA one.

## 5. The recording proxy

Whether a developer's `HTTP(S)_PROXY` sees router traffic. `recipes/proxy.py` records each request's first line and whether it held the canary, and answers 502.

```sh
recipes/iso.sh proxy-claude proxy.sh claude
recipes/iso.sh proxy-codex proxy.sh codex
recipes/iso.sh proxy-codex-noproxy env NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 proxy.sh codex
```

The router must see the harness directly: `proxy saw N requests, 0 to the router, 0 holding the canary`. The third, with `NO_PROXY`, is the control that goes green.

## 6. Hostile paths

### 6a. Another user, odd folders, bad config

A caller of another uid gets 403 and reaches no account; a state folder whose name holds a quote, `$HOME`, a backtick, `é` and a newline works under a symlinked config folder with private modes; each bad config fails with its reason.

```sh
ISO_UNSHARE='-rn --map-auto' recipes/iso.sh hostile hostile.sh
```

```
uid 4242 canary 403
own uid clean 200
odd state folder, symlinked config folder 200
corrupt config: SchemaError: Expected a valid JSON string
BAA key env unset: KeyUnreadable: keyEnv PHI_TEST_BAA_KEY gave no key
{"received":{"open":2,"baa":0,"judge":2},"canaryAt":{"open":false,"baa":false},"lanes":["clean/open/clean"]}
```

### 6b. `bun run wire pi` in hostile folders

The full pi wire run with HOME, every XDG folder, the agent folder and TMPDIR under a name holding a quote, `$HOME`, a backtick, `é`, a space and a newline. `ODD` replaces the name.

```sh
recipes/iso.sh hostile-wire hostile-wire.sh pi
recipes/iso.sh hostile-wire-no-newline env "ODD=-quote' \$HOME \`backtick\` é" hostile-wire.sh pi
```

Without the newline every check passes. With it, the two `doctor pi` checks fail, because `src/router/client/pi.ts` splits `pi list` output on newlines.

## 7. A repository's Claude Code settings

With the plugin installed and `phi-router on claude` run, a project `.claude/settings.json` that sets `ANTHROPIC_BASE_URL` to another listener, with or without a path, or turns on `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX`, blocks the canary prompt and names the setting. A session with no project settings replies `ok` through the router. A `--file` download goes to the router, which answers 404. A recording proxy in `HTTPS_PROXY` shows what each turn sent past the router.

```sh
recipes/iso.sh project-settings project-settings.sh
```

```
unchanged: exit 0, other listener got 0 requests
  ok
ANTHROPIC_BASE_URL: exit 0, other listener got 0 requests
  UserPromptSubmit operation blocked by hook:
  ... MovedOff: phi-router: ANTHROPIC_BASE_URL moves this Claude Code session off the router, so the hook stopped it. ...
CLAUDE_CODE_USE_BEDROCK: exit 0, other listener got 0 requests
file: exit 0, other listener got 0 requests
  ... [files-api] Downloading file file_phi38 from http://127.0.0.1:47411/v1/files/file_phi38/content
  ... [files-api] Failed to download file file_phi38: File not found: file_phi38
```

`claude -p` exits 0 on a prompt a hook blocked. The script exits 1 with a `FAIL` line when the clean turn does not reply `ok`, a setting is not named, or the other listener gets any request. Each turn sends one `CONNECT api.anthropic.com:443` through the proxy, the unchanged turn included, and the Vertex turn probes Google's metadata address before its prompt.
