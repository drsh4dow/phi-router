# Feature map

One file per thing a user of phi-router meets. Each says how a user reaches it, how to drive it, and what end state proves it.

| Feature                               | File                             | Driven by                                                                     |
| ------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------- |
| Claude Code through the router        | [claude-code.md](claude-code.md) | `bun run wire claude`, `bun run wire:accounts claude`                         |
| Codex through the router              | [codex.md](codex.md)             | `bun run wire codex`, `bun run wire:accounts codex`                           |
| pi through the router, `/phi setup`   | [pi.md](pi.md)                   | `bun run wire pi`, `bun run wire:accounts pi`, [recipes.md](../recipes.md) 4b |
| The router's life: start, lease, exit | [lifecycle.md](lifecycle.md)     | `bun run wire pi`, [recipes.md](../recipes.md)                                |
