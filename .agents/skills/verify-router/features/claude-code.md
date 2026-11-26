# Claude Code through the router

## Sub-features

- The clean lane: a request with no sealed content goes to an open account with the target model.
- The sealed lane: a request whose new content seals goes to a BAA account, with the BAA credential only.
- The border: a later request on the clean lane carries a stub where the sealed part was.
- Tool results: a tool result with a canary sends the request to the BAA account.
- Overflow: when the open account answers 429, a clean request runs on the BAA account, and the turn's end shows `phi-router: your subscription is rate-limited until HH:MM, so 1 request ran on your BAA account. Add another subscription: npx phi-router accounts add` once per stamp. `/phi` shows `Clean lane: open (rate-limited until HH:MM)`.
- The pinned subagent: the plugin's agent `phi-router:phi-sealed` runs on `phi/sealed`, so its requests go to a BAA account under the sealed model.
- The answer check: the plugin's `SubagentStop` hook (matcher `^phi-router:phi-sealed$`) runs `phi-router answer-check`, which posts the subagent's last answer to the router. A cleared answer reaches the root agent unchanged. A sealed one comes back to the subagent as a rewrite (exit 2, the reason on stderr): `phi-router withheld your last answer: <kind and quoted value, or the judge's score>. … This is rewrite attempt N of 5 …` and the way out, a 0600 file in the session's files folder. After 5 rewrites the hook lets the answer go and a `PostToolUse` hook on `^Agent$` replaces the root agent's tool result with `[sealed hN] The pinned subagent's answer still held patient identifiers after 5 rewrites, …`, and the turn's end shows `phi-router: 1 pinned subagent answer still held patient identifiers after 5 rewrites, …` once. `/phi` shows `Pinned subagent: N runs, M rewrites, K answers withheld`.
- Auto mode: the subagent hands back through the `SubagentHandback` tool instead, and a `PreToolUse` hook on `^SubagentHandback$` denies it with the rewrite or swaps `tool_input.message` for the handle reply. Auto mode refuses to run against a mock, so only the live run proves it.
- The status line: `phi-router on claude` and `setup claude` set Claude Code's `statusLine` to the plugin's launcher with `statusline` when none is set, and print the line to add to a script that is. On `phi/auto` or `phi/sealed` it shows `phi · <last request> · N sealed · M cleared`, the counts `/phi` shows, and nothing on another model (`recipes/iso.sh statusline statusline.sh`).
- A repository's settings: a project `.claude/settings.json` that moves `ANTHROPIC_BASE_URL` or turns on a provider switch blocks the prompt and names the setting (`recipes/iso.sh project-settings project-settings.sh`).

## How to get to it (user POV)

The user sets `ANTHROPIC_BASE_URL` to the router (`phi-router on claude` writes it into Claude Code's settings), picks model `phi/auto`, and works as usual.

## Driving it with the real binary

- Mocks: `unshare -rn sh -c 'ip link set lo up && exec bun run wire claude'`. `claude -p` turns of one session: the clean and canary turns, a Read of a planted chart, an `Agent` call with `subagent_type` `phi-router:phi-sealed` and `run_in_background` false whose first answer holds the SSN, `/compact` and a router restart, then five more scoped tasks (a clean answer, a name the judge seals, an answer that never clears, a Read before the answer, and a 0600 file of identifiers), and last the overflow play: a prompt the open mock answers 429, a second clean prompt inside the stamp, and `/phi`. The subagent turns pass `--include-hook-events`, so the printed stream holds each `SubagentStop` hook's exit code. Proof: `pass` on every check, among them `pass no open body holds a complete canary of h-0051-ssn` and the `AC8` to `AC17` answer-check lines.
- Real accounts: `bun run wire:accounts claude` with `XDG_CONFIG_HOME` naming the account config. Proof: `request 1: clean lane`, `request 2: sealed lane ... reason sealed new content`, and every check `pass`.

## Gotchas

- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` keeps one model request per `-p` turn. Without it Claude Code sends side requests, and the lane log holds more lines.
- The session header is `x-claude-code-session-id`.
- A Claude Code run with `-p` allows only the tools `--allowedTools` names, in the subagent too: the wire run allows `Read,Bash` so the subagent can write its file.
- Claude Code caps `SubagentStop` blocks at 8 in a row (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`), above the router's 5 rewrites, and appends an `agentId: … (use SendMessage …)` trailer and a `<usage>` block to every Agent tool result, the replaced one too.
- Claude Code runs a subagent in the background unless the call says `run_in_background: false`. Its answer then arrives in a notification in the next user message, so that turn runs sealed and the turn after it goes open with the stub.
