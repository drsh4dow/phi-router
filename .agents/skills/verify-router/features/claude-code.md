# Claude Code through the router

## Sub-features

- The clean lane: a request with no sealed content goes to an open account with the target model.
- The sealed lane: a request whose new content seals goes to a BAA account, with the BAA credential only.
- The border: a later request on the clean lane carries a stub where the sealed part was.
- Tool results: a tool result with a canary sends the request to the BAA account.
- The pinned subagent: the plugin's agent `phi-router:phi-sealed` runs on `phi/sealed`, so its requests go to a BAA account under the sealed model, and its answer comes back to the main session as a tool result that is judged.
- A repository's settings: a project `.claude/settings.json` that moves `ANTHROPIC_BASE_URL` or turns on a provider switch blocks the prompt and names the setting (`recipes/iso.sh project-settings project-settings.sh`).

## How to get to it (user POV)

The user sets `ANTHROPIC_BASE_URL` to the router (`phi-router on claude` writes it into Claude Code's settings), picks model `phi/auto`, and works as usual.

## Driving it with the real binary

- Mocks: `unshare -rn sh -c 'ip link set lo up && exec bun run wire claude'`. Four `claude -p` turns of one session, then a second session whose open mock calls `Agent` with `subagent_type` `phi-router:phi-sealed` and `run_in_background` false. Proof: `pass` on every check, among them `pass no open body holds a complete canary of h-0051-ssn`.
- Real accounts: `bun run wire:accounts claude` with `XDG_CONFIG_HOME` naming the account config. Proof: `request 1: clean lane`, `request 2: sealed lane ... reason sealed new content`, and every check `pass`.

## Gotchas

- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` keeps one model request per `-p` turn. Without it Claude Code sends side requests, and the lane log holds more lines.
- The session header is `x-claude-code-session-id`.
- Claude Code runs a subagent in the background unless the call says `run_in_background: false`. Its answer then arrives in a notification in the next user message, so that turn runs sealed and the turn after it goes open with the stub.
