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

`serve` with no lease stops after one lease check; the router stops once the leased pid dies; `start` for a dead pid fails naming it; a missing `config.json` fails `start` at once with the line for a missing BAA key, and `serve` names the file and exits 3.

```sh
recipes/iso.sh exits exits.sh
```

```
no lease: serve exited 1 after 5 s
start exited 0
router answers on 47411
lease ended: port closed 5 s after the holder died
dead pid: start exited 1
no config: start exited 1 after 0 s
no config: serve exited 3
```

Each command's own line comes before its result. The times vary with load: 5 to 6 s in three runs, against the 5 s lease interval. The script exits 130, from its last `wait` on the mocks it stops.

### 2b. pi when its router cannot start

```sh
recipes/iso.sh pi-failed-start pi-failed-start.sh
```

```
pi with no config.json exited 0
phi-router stopped this message. It is missing your BAA key or the OpenAI key for its PHI check. Nothing left your computer. Type /phi setup.
lines holding the login: 0
```

pi's input hook stops the prompt, so `pi -p` exits 0.

### 2c. What each harness shows when phi-router stops a message

For HARNESS `claude`, `codex` or `pi`: with no `config.json`, with a `config.json` whose BAA key file is missing, with a `config.json` the router cannot read, and with a BAA mock that answers 401, a canary prompt is stopped and the harness shows the line `src/router/features/route/stopped.ts` holds for it. Claude Code and pi run in print mode, Codex in its TUI in tmux.

```sh
recipes/iso.sh refusals-claude refusals.sh claude
recipes/iso.sh refusals-codex refusals.sh codex
recipes/iso.sh refusals-pi refusals.sh pi
```

```
== no config.json
[".../plugins/claude/bin/phi-router" session-start --claude --pid "$PPID" --address "$ANTHROPIC_BASE_URL" 1>&2 || exit 2]: phi-router stopped this message. It is missing your BAA key or the OpenAI key for its PHI check. Nothing left your computer. Run in a terminal: npx phi-router setup claude
== a config.json whose key file is missing
[...]: phi-router stopped this message. It is missing your BAA key or the OpenAI key for its PHI check. Nothing left your computer. Run in a terminal: npx phi-router setup claude
== a router that cannot start
[...]: phi-router could not start, so this message was not sent. Nothing left your computer. Send it again. If it repeats, run: npx phi-router doctor claude
== a BAA account that answers 401
API Error: 400 phi-router stopped this message. Your BAA account refused its key, so nothing was sent, and nothing reached your subscription. Run in a terminal: npx phi-router setup claude --new-key
{"received":{"open":0,"baa":6,"judge":8},"canaryAt":{"open":false,"baa":true},"lanes":["sealed/baa/sealed new content",...]}
```

Codex shows each hook line under `Blocked by hook` and the 401 line in its error JSON; pi shows the hook lines alone and the 401 line as `400 {"error":{"message":"..."}}`. Each names its own harness in the command. Claude Code sends a request answered 400 five more times, the last ones with `thinking` and no `display`, so the BAA mock counts 6. The router cannot start because its `config.json` is `{`, so that case waits out `start`'s 10 s, twice for Claude Code and Codex, whose session-start hook tries first. Each case's full output is in `$ROOT/work/<case>.out`.

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

### 4b. `/phi setup` in the pi TUI

The real `pi`, signed in to a Claude login with no key on the machine, types `/phi setup` in tmux. pi's own Anthropic provider points at the open mock, so a model turn would reach it. Setup's key checks go to `recipes/key-check.ts`, which answers 200 and logs whether each check carried the key canary. Setup's own test runs on the mocks `phi-router` starts for it. The script types the Anthropic key and pastes the OpenAI key, both canaries, and captures the pane while each is in the field. Panes land in `$ROOT/captures`.

```sh
recipes/iso.sh setup-tui setup-tui.sh max
```

```
 ✓ Anthropic key works
 ✓ OpenAI key works
 ✓ Installed phi-router in pi
 ✓ Test: a fake patient record went to your BAA account, not Claude
   Everyday work   Claude
   Patient data    Anthropic API key
   PHI check       OpenAI
 This session now runs on phi/auto. Only phi/auto is protected. Other models in /model skip phi-router.
...
0.0%/200k (auto)                                                     (phi) auto • medium
phi · none yet · 0 sealed · 0 cleared
anthropic-typed: > ******************************************456789
openai-pasted: > **********************************543210
mocks: {"received":{"open":0,"baa":0,"judge":0},"canaryAt":{"open":false,"baa":false},"lanes":[]}
key checks:  1 GET /v1/models anthropic canary=true; 1 GET /v1/models openai canary=true
files holding the key canary: config/phi-router/keys/anthropic config/phi-router/keys/openai
```

It exits 1 with a `FAIL` line when pi shows no BAA question or key field, setup does not end on `phi/auto`, the footer does not name `(phi) auto`, a captured pane holds the canary, the open mock gets any request, or any file under the run's folder but phi-router's key files holds the canary. The other worlds:

- `setup-tui.sh enterprise` picks `Claude Enterprise login` with `BROWSER` set and a fake `claude` whose `auth login` writes a login. The last screen starts with `! Check that your BAA covers Claude Code through phi-router. Anthropic doesn't cover a custom base URL by default.`
- `setup-tui.sh headless` makes the same pick with no `DISPLAY` and no `BROWSER`. Within seconds pi shows `This machine has no browser. In any terminal, run ``CLAUDE_CONFIG_DIR='<login folder>' claude auth login`` and follow the steps. When it says you're signed in, type /phi setup again.` and keeps its model. The script runs that command, types `/phi setup` again, and ends on `phi/auto` with the login as Patient data.
- `setup-tui.sh apikey` signs pi in with an API key. pi shows `You don't need phi-router. It keeps patient data off a subscription with no BAA, and you're on an API key. Nothing changed.` and keeps its model.
- `setup-tui.sh terminal` and `terminal-apikey` run `phi-router setup pi` in the same worlds, for the terminal form's question and stop line.

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

Without the newline every check passes. With it, the two `doctor pi` checks fail, because `src/router/client/harnesses/pi.ts` splits `pi list` output on newlines.

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

## 8. Setup inside the Claude Code window

The real claude TUI in tmux follows the README line as SETUP.md asks: the agent runs `npx phi-router setup claude --json`, asks each question with `AskUserQuestion`, runs `--apply`, says apply's last line, and runs `--apply` again when the user says `done`. Then the user types a clean prompt and a canary prompt. Setup reads the machine as it would a user's, so nothing points claude at a mock: api.anthropic.com and api.openai.com resolve to loopback through a bind-mounted `/etc/hosts` and `/etc/nsswitch.conf`, and `recipes/setup-claude-mock.ts` serves both on 127.0.0.1:443 behind a throwaway CA in `NODE_EXTRA_CA_CERTS`, which claude, bun and node honor. Its open account plays the agent from the conversation in each request, and answers auto mode's safety check with `<block>no</block>`, as the real check answers a command it lets run, so auto mode stays on. A fake Max login lives in `.credentials.json`, with the `oauthAccount` a real login leaves in `.claude.json`: without it `claude auth status` prints `"email": null`, which setup reads as signed out. `say` presses Enter again while the text sits in the input box, because a loaded machine can drop the first Enter. `configure` types no key until the options panel shows, and tries again 3 s later while Claude Code says the plugin isn't installed: right after the shell install it said so once, about 2 s after the install, and opened the panel from about 8 s on. Its BAA account, the key checks and the judge answer by credential. It logs each request to `$ROOT/mock.jsonl` with whether it held the canary or a fake key, never a value. `npx` is a shim that runs this checkout's launcher, with `--source` for setup.

```sh
ISO_UNSHARE=-rnm recipes/iso.sh setup-claude-found setup-claude.sh found-keys
ISO_UNSHARE=-rnm recipes/iso.sh setup-claude-pasted setup-claude.sh pasted-keys
ISO_UNSHARE=-rnm recipes/iso.sh setup-claude-headless setup-claude.sh headless
ISO_UNSHARE=-rnm recipes/iso.sh setup-claude-tool setup-claude.sh found-keys-tool
ISO_UNSHARE=-rnm recipes/iso.sh setup-claude-delay setup-claude.sh found-keys-delay
```

| Run           | Starts with                                                   | The user                                                                                                                           | The agent ends with                         |
| ------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `found-keys`  | a fake Max login, an Anthropic key in pi, `OPENAI_API_KEY`    | picks the two found keys, then types `/reload-plugins`                                                                             | `Done. Type /reload-plugins to turn it on.` |
| `pasted-keys` | a fake Max login and no key                                   | picks an Anthropic API key, pastes both keys in `/plugin configure phi-router`, whose save reloads the plugins, and says `done`    | `Done. This window is protected.`           |
| `headless`    | a fake Max login, `OPENAI_API_KEY`, no `DISPLAY` or `BROWSER` | picks a Claude Enterprise login, runs the command setup printed in a second tmux window, says `done`, then types `/reload-plugins` | `Done. Type /reload-plugins to turn it on.` |

```
pass apply exited 0
pass the agent ended with: Done. This window is protected.
pass a router answers on 47411 10 s after apply
pass no connection retry after apply
pass a router answers on 47411 after the first prompt
pass no connection retry in the whole run
pass lane log: clean, then sealed for the canary
pass the canary reached the BAA account
pass the canary reached no other account
pass no fake key reached the open account
pass the keys are only in: claude/.credentials.json config/phi-router/keys/anthropic config/phi-router/keys/openai config/phi-router/keys/pasted/anthropic config/phi-router/keys/pasted/openai
```

That is `pasted-keys`. The last check greps every file of the run, the Claude Code folder, HOME and its transcripts included, and allows a key only in phi-router's key files, the Claude Code credentials file that holds plugin options, and pi's `auth.json`. `headless` prints the environment and the command it ran, `DISPLAY='' BROWSER='' WAYLAND_DISPLAY=''` and `the terminal runs setup's command: CLAUDE_CONFIG_DIR='…/logins/claude-baa' claude auth login`. A vendor sign-in cannot finish offline, so in that terminal alone a `claude` shim answers `auth login` by writing the Claude Enterprise login it would leave. The screens are `$ROOT/screen-*.txt`, and `env MOCK_BODIES=<folder> setup-claude.sh RUN` keeps each `/v1/messages` body.

A run is one `case` block: `start` writes the starting state and `drive` types until the last apply, with `say`, `pick LABEL` (arrow keys, then Enter) and `configure ANTHROPIC_KEY OPENAI_KEY`. `found-keys-tool` and `found-keys-delay` start as `found-keys` and test the turn after apply, which reaches the router's address once Claude Code reloads `settings.json`. In `-tool` the agent runs `sleep 3; printf setup-confirmation` after its last line; in `-delay` the `npx` shim returns 3 s after apply ends. Both pass only because apply leases a router to the Claude Code instance before it writes the address: a screen line with `ECONNREFUSED`, `Retrying` or `attempt N/M` fails every run.
