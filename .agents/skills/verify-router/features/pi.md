# pi through the router

## Sub-features

- The pi package: installed from git, it registers `phi/auto`, `phi/sealed` and `phi/<id>` for each Anthropic model of pi's own catalog, with that catalog's limits, gives `phi/auto` and `phi/sealed` the limits of the models `config.json` names for them (200K and 32K when the catalog lacks the model or `phi-router models` fails), and starts the router through its lease. A request on `phi/<id>` runs `<id>` as its target model, so a delegate on `phi/claude-opus-5-5` runs Claude Opus 5.5. `/model phi/sealed` pins the session's requests while it is selected. The package ships no subagent tool.
- The clean and sealed lanes on `/pi/v1/messages`, with the session header `x-phi-session`.
- The pinned delegate: a pi on `phi/sealed` with `PHI_ROUTER_SESSION` set to the root agent's session, as pi-harness starts its delegate, sends that session in `x-phi-session` and checks its last answer before it settles. A rewrite continues it with a `phi-router-rewrite` message, and a withheld answer replaces the answer in its session. The wire run here starts no delegate. `src/pi/features/phi/pinned.test.ts` covers it.
- Overflow: as for Claude Code. pi shows the marks in its status bar through `ctx.ui.setStatus`, which RPC mode prints as an `extension_ui_request` with `method` `setStatus`, and never notifies; `/phi` says them in full. Both run the launcher's `statusline`, as Claude Code's mod does, so the two show the same words. Print mode has no UI and shows nothing.
- The router's lease: each pi holds one, and the router exits once the last pi has.
- `/phi setup`: setup inside pi, with pi's list dialog for each question, a masked field for each key, and the session on `phi/auto` at the end. It runs `phi-router setup pi --json` and `--apply`, with each key in the child's environment.

## How to get to it (user POV)

The user installs the package (`pi install git:<repo>`), types `/reload` and `/phi setup`, and works as usual on `phi/auto`. The package starts the router.

## Driving it with the real binary

- Mocks: `unshare -rn sh -c 'ip link set lo up && exec bun run wire pi'`. Proof: every check `pass`, among them `pass the router is down within 11 s of the last pi exiting`. The overflow play is one `pi --mode rpc`: `set_model` to `phi/auto`, a prompt the open mock answers 429, and, once pi prints `agent_start`, a second prompt with `streamingBehavior` `followUp`, then `/phi`. Sent at once, pi can drop the first prompt and run only the second.
- Real accounts: `bun run wire:accounts pi`, which loads `plugins/pi/extension.mjs` with `-e`. Proof as for Claude Code.
- `/phi setup`: [recipes.md](../recipes.md) 4b, in tmux. Proof: the footer names `(phi) auto`, the open mock got no request, and only phi-router's key files hold the key canary.

## Gotchas

- `pi --list-models phi` shows the provider's models. pi's filter is fuzzy, so a few `anthropic` rows show too. `tools/pi/limits.e2e.test.ts` drives it with a `config.json`.

- pi runs the bundle, not `src/`. `bun run wire` builds it first. Before any other drive, run `bun run build` after a change under `src/`.
- `PI_CODING_AGENT_DIR` must be a throwaway folder; never the real `~/.pi`.
