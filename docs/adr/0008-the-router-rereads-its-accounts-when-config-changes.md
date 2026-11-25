# The router rereads its accounts when config.json changes

A running router reads `config.json` under the XDG config folder each time a request arrives: a harness's model request and `status`. When the file's text differs from the text it last read, it builds the accounts of both lanes again, which runs each key command once, and serves them from that request on. A request takes the accounts once, when it arrives, and walks those to its end. `phi-router accounts add` only writes the file.

We chose this because `/phi` must list an account right after `accounts add`, in the session that is already open. Reading a 1 KB file took under 15 µs on Bun and on Node (10,000 reads each), next to the judge call and the account call a request makes. Comparing the text needs no new route, no new wire between the CLI and the router, and no branch for "no router answers". A hand edit of the account lists, `targetModel` or `sealedModel` reaches the router the same way.

## Considered options

- `accounts add` asks the running router to reload over its port, as `status` asks it (ADR 0007). Rejected because it adds a route, a client call and its failure cases, and the router still has to rebuild its accounts. A hand edit would still need a restart.
- Watch the file for changes. Rejected because a watcher is one more resource the router must hold and close, and the next request reads the file anyway.
- Keep the accounts that did not change and build only new ones. Rejected as more than this needs. A rebuild starts each login folder's state fresh.

## Consequences

- A text the router cannot serve, or a file it cannot read, keeps the accounts it serves and logs a warning. The router tries a changed text once. It reads the file again only after the text changes again.
- `judge`, `fixtures` and `baaRepos` are read once, when the router starts. A change to them needs a restart.
- Adding an open account changes how many accounts the clean lane holds, so a session's home account may move.
- A rebuild drops what each login folder remembered, such as the token a 401 rejected. The next send with that token may get one more 401, which the walk handles as any 401.
- A key command that never exits holds every request that arrives while the router rebuilds.
