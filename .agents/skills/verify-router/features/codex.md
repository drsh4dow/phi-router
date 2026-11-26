# Codex through the router

## Sub-features

- The clean and sealed lanes, as for Claude Code, on the OpenAI Responses wire.
- Overflow: as for Claude Code. The Stop hook's notice shows as `↳ Hook · phi-router: ...`, and `phi` shows the status under `Blocked by hook`.
- The model catalog: Codex's `/models` GET is answered from the open account and lists the target model.
- Encrypted reasoning: a 400 that rejects it is resent once without it.
- The TUI's thread-title request: it goes sealed with no judge call, and its lane line's reason is `title`.
- The pinned subagent: `phi-router on codex` writes the role `phi-sealed` on `phi/sealed` to `agents/phi-sealed.toml`, and the role's model wins over `spawn_agent`'s `model` argument. The router puts back each handle its task names. Codex has no answer check, so a sealed answer reaches the root agent as a stub with a handle.

## How to get to it (user POV)

The user runs `phi-router on codex`, which adds a `phi` model provider whose `base_url` is the router's `/v1`, and picks model `phi/auto`.

## Driving it with the real binary

- Mocks: `unshare -rn sh -c 'ip link set lo up && exec bun run wire codex'`. Five `codex exec` turns, the later ones `resume --last`, then a session whose open mock calls `multi_agent_v1.spawn_agent` with `agent_type` `phi-sealed` and then `wait_agent`. Last, the overflow play runs in the Codex TUI in tmux (`codex --no-daemon --dangerously-bypass-hook-trust resume <session>`): a prompt the open mock answers 429, a second clean prompt inside the stamp, and `phi`. Proof: every check `pass`.
- Real accounts: `bun run wire:accounts codex`. Proof: `request 1: clean lane, account <open>`, `request 2: clean lane, account <open>, … reason clean`.

## Gotchas

- Every Codex home needs `check_for_update_on_startup = false`; the update prompt starts a global install.
- Run it outside a git repository.
- The lane log does not log the `/models` GET.
- `codex exec` shows no hook message: it prints `hook: Stop Completed` and drops the Stop hook's `systemMessage` and a prompt hook's block reason, in text and in `--json` alike. Only the TUI shows them, so the overflow play runs there.
- `bun run wire codex` needs `tmux` on `PATH`.
- The TUI asks `Trust this folder?` for a git repository it does not trust, and `-c projects...trust_level` does not skip it. The wire run writes the folder's `[projects."<folder>"] trust_level = "trusted"` into `config.toml`. Text typed and Enter sent at once lands in the composer unsent, so the driver waits 1 s before Enter.
- The TUI sends two title requests per turn, each under a session id of its own. The wire run counts those ids as sessions the harness kept.
- With a catalog entry that offers `tool_search`, Codex defers the multi-agent tools behind it, yet runs a direct `spawn_agent` call. `codex exec` can end before a subagent answers, so the wire's open mock waits with `wait_agent`.
