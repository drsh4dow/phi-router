# Codex reaches the router through one `.env` line

`on codex` takes Codex's requests to the router off the developer's proxy by appending one line to `.env` in Codex's home: `NO_PROXY="${NO_PROXY},${no_proxy},127.0.0.1" # added by phi-router on`. Codex reads `NO_PROXY` over `no_proxy`, so the one setting keeps the developer's own list under either spelling, as the shell gives it when Codex starts, and adds the router's address. The entry is the bare address because Codex skips a host and port in that list. `off codex` removes only a line whose text is exactly this one, so a line of the developer's own, even an identical setting without the trailing mark, stays.

We chose this because the line lives in developers' files: once written, its exact text is what `off` and `doctor codex` recognize, so changing it strands every line already written.

## Considered options

- A `no_proxy` line. Rejected because Codex reads `NO_PROXY` over it, so a developer's `NO_PROXY` would hide the router's address.
- `127.0.0.1:<port>`, as `on claude` writes for Claude Code. Rejected because Codex skips a host and port there, so its requests would still go through the proxy.
