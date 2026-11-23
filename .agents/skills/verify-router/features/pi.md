# pi through the router

## Sub-features

- The pi package: installed from git, it registers `phi/auto`, `phi/sealed` and `phi/<id>` for each Anthropic model of pi's own catalog, with that catalog's limits, gives `phi/auto` and `phi/sealed` the limits of the models `config.json` names for them (200K and 32K when the catalog lacks the model or `phi-router models` fails), and starts the router through its lease. A request on `phi/<id>` runs `<id>` as its target model, so a delegate on `phi/claude-opus-5-5` runs Claude Opus 5.5. `/model phi/sealed` pins the session's requests while it is selected. The package ships no subagent tool.
- The clean and sealed lanes on `/pi/v1/messages`, with the session header `x-phi-session`.
- The router's lease: each pi holds one, and the router exits once the last pi has.

## How to get to it (user POV)

The user installs the package (`pi install git:<repo>`), picks model `phi/auto`, and works as usual. The package starts the router.

## Driving it with the real binary

- Mocks: `unshare -rn sh -c 'ip link set lo up && exec bun run wire pi'`. Proof: every check `pass`, among them `pass the router is down within 11 s of the last pi exiting`.
- Real accounts: `bun run wire:accounts pi`, which loads `plugins/pi/extension.mjs` with `-e`. Proof as for Claude Code.

## Gotchas

- `pi --list-models phi` shows the provider's models. pi's filter is fuzzy, so a few `anthropic` rows show too. `tools/pi/limits.test.ts` drives it with a `config.json`.

- pi runs the bundle, not `src/`. Run `bun run build` after a change under `src/`.
- `PI_CODING_AGENT_DIR` must be a throwaway folder; never the real `~/.pi`.
