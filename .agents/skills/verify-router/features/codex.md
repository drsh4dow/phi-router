# Codex through the router

## Sub-features

- The clean and sealed lanes, as for Claude Code, on the OpenAI Responses wire.
- The model catalog: Codex's `/models` GET is answered from the open account and lists the target model.
- Encrypted reasoning: a 400 that rejects it is resent once without it.
- The TUI's thread-title request: it goes sealed with no judge call, and its lane line's reason is `title`.
- The pinned subagent: `phi-router on codex` writes the role `phi-sealed` on `phi/sealed` to `agents/phi-sealed.toml`, and the role's model wins over `spawn_agent`'s `model` argument.

## How to get to it (user POV)

The user runs `phi-router on codex`, which adds a `phi` model provider whose `base_url` is the router's `/v1`, and picks model `phi/auto`.

## Driving it with the real binary

- Mocks: `unshare -rn sh -c 'ip link set lo up && exec bun run wire codex'`. Five `codex exec` turns, the later ones `resume --last`, then a session whose open mock calls `multi_agent_v1.spawn_agent` with `agent_type` `phi-sealed` and then `wait_agent`. Proof: every check `pass`.
- Real accounts: `bun run wire:accounts codex`. Proof: `request 1: clean lane, account <open>`, `request 2: sealed lane, account <BAA>`.

## Gotchas

- Every Codex home needs `check_for_update_on_startup = false`; the update prompt starts a global install.
- Run it outside a git repository.
- The lane log does not log the `/models` GET.
- With a catalog entry that offers `tool_search`, Codex defers the multi-agent tools behind it, yet runs a direct `spawn_agent` call. `codex exec` can end before a subagent answers, so the wire's open mock waits with `wait_agent`.
