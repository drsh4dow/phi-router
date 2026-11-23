# Folder names carry the import rules, and three gates enforce them

The code lives in two runtime folders, `src/router/` for the router process and `src/pi/` for the extension pi loads into its own process. They never import each other, types included. `src/shared/` holds the schemas both read, and the `phi-router` CLI is the one contract between them: pi runs the CLI and decodes its JSON with `src/shared/cli.ts`, as the Claude Code and Codex hooks will. Inside a runtime folder, `features/<name>/` holds one piece of product work, `client/` holds the one writer of each durable value and the only code that touches an outside system, and `primitives/` holds blocks that know no feature. The full map, one row per noun with its writer and its allowed imports, and the 19 bans with their owners are the ones the owner approved. He also approved two readings of it. A test imports what the code beside it may import, plus `@effect/vitest`, so it can replace a `client/` service with a test layer. A ban enters with its owner file, and until then another gate must reject the API.

We chose this because the next contributor is an agent that copies the nearest file and takes the shortest path that compiles. A rule written in prose loses to that path. A folder name that a gate checks does not. So `bun run check` fails on an import the map forbids (dependency-cruiser, one rule per Imports key), on a file under `src/` that is not a `.ts` file in a row of the map (dependency-cruiser), on an API used outside its owner, on a comment that is not a doc comment directly before a declaration (ast-grep), and on a suppression directive (a text scan, which no directive can switch off). A ban holds in every folder under `src/`, `src/shared/` included, and lifts only for its owner. It bans the root a shortcut would start from: the module path in dependency-cruiser, and the global identifier, the root `effect` import and Effect's runners in oxlint. Each message names the file or function to call instead. Each gate has a fixture that breaks it and a test that expects the failure.

## Considered options

- One runtime folder for everything. Rejected because the pi extension runs in pi's process on pi's runtime, and the router runs in its own. An import between them would compile and then fail at runtime, or pull router code into pi.
- pi calls the router over HTTP with its own client. Rejected because the Claude Code and Codex hooks can only run a command. One CLI contract serves all three harnesses, and `shared/cli.ts` decodes it once.
- List the banned spellings per runtime folder. Rejected because each list left out a folder or a form, such as a re-export through `src/shared/`, a destructured global or a named runner import, and every one passed `check`.
- Install every approved ban at once. Rejected because a ban message must name a function that exists. A ban whose owner exists goes in now. A ban whose owner file does not exist yet goes in with that file, and only while another gate rejects the API meanwhile. The config write export, `addAccount` in `src/router/client/config-writer.ts`, went in with its ban. The identifier-kind ban went in with the policy.

## Consequences

- A change to the map is a new ADR, and a new exemption is one `overrides` entry in `.oxlintrc.jsonc` that review must catch.
- No gate stops two client files from writing the same path. Review holds that rule.
- Code that hides what it calls, such as a computed member name or `eval`, passes the gates. Review holds it.
- An owner file is trusted with its whole API. It cannot re-export a package, but it can still hand a raw service out under a name of its own, and review holds that.
- A lint rule goes off only for a collision proved by files, or with the owner's approval, and its line in `.oxlintrc.jsonc` says which.
