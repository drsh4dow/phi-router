# Edge files at every depth, twenty entries per folder, and no comments

This amends ADR 0003 in three places. Every folder inside a feature, `client/` or `primitives/`, at any depth, is a module whose `index.ts` is the only file code outside it imports, so `client/` may hold folders such as `client/judge/` and a feature may hold folders such as `features/cli/doctor/`. A folder under `src/` holds at most 20 entries and a file at most 600 lines, and past either cap the part becomes a folder named for its concept, never a suffixed sibling such as `doctor-codex.ts`. A source file holds no comment at all, doc comments included: what a comment said goes to a name, a type, a test, an issue or an ADR.

We chose this because the agent that copies the nearest file copied the shape ADR 0003 left open. A flat `client/` grew to 41 files, `features/cli/` to 35, with name-stem siblings standing in for the modules they were. A doc comment that restated its declaration passed the old check and went stale with nothing to catch it. The edge-file rule and the width gate in `bun run check` make the module the shortest path, and the comment check leaves a name, a type or a test as the only place to say what code does.

## Considered options

- Keep the doc-comment exemption. Rejected because 1,958 doc comments were the main place the code restated itself, and no gate could tell a true one from a stale one.
- Raise the folder cap per folder. Rejected because every raised cap became the new nearest file to copy. An exception is a line in `size-limits.txt` with its reason, which review must catch.
- Fold `config-writer.ts` into `client/configuration/`. Rejected because the `config-writer` gate names its path, and an edge file would hand `addAccounts` to every importer of the configuration.

## Consequences

- `tools/` keeps the comment check but not the width gate, since it is outside the source root.
- Only `src/router/client/` imports `client/private-file.ts`, so a feature can no longer write a harness's files itself. Codex's files have one writer, `client/harnesses/`.
