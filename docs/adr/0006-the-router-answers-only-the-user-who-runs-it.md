# The router answers only the user who runs it

Every request to the router passes one check before its path is matched or its body is read. The router looks up the two ends of the request's TCP connection in the machine's list of sockets and serves the request only when one uid holds both: the caller's end and the router's own end. Anything else gets `403` with an Anthropic-shaped `permission_error`, and reaches no account and no judge. The check is the `middleware` of the HTTP server in `src/router/client/router-port/server.ts`, so every row of the path table, the lease row and any row a later ticket adds sit behind it with no code of their own. `src/router/client/router-port/callers.ts` owns the lookup.

We chose this because the router holds the developer's credentials and state, and any user of the machine can connect to `127.0.0.1`. The kernel already knows who holds each socket, so the router asks it and the harnesses change nothing. The router's own end carries the router's uid, so the router never asks for its uid, and source code names no `process`.

- **Linux.** `/proc/net/tcp` lists every IPv4 TCP socket of the network namespace with the uid that holds it, each user's included. The router reads it once per request and matches both ends by address and port.
- **macOS.** There is no `/proc`. The router runs `lsof -nP -iTCP@<router end> -Fun`, which prints each process's uid and each connected socket. A user who is not root sees only the sockets of their own processes there, so another user's end is never listed and the request is refused. This was not run on macOS. It was run on Linux, where `lsof` behaves the same for a user who is not root.

## Considered options

- A per-user secret in a header, set by `on claude`, `on codex` and the pi extension. Rejected because it needs every harness's settings to carry a secret and the CLI to write it, where the socket list needs no setting at all.
- `lsof` on Linux too. Rejected because a machine without `lsof` would refuse every request, and each request would pay a subprocess where reading `/proc/net/tcp` takes a few milliseconds.
- Keep Bun's own HTTP server. Rejected because Effect's request carries the caller's address but not its port, and Bun's server keeps the port in a private field. The entry file now builds Node's `http` server on both runtimes, so `request.source.socket` names both ends. Bun runs Node's server through its own compatibility layer. So HTTP alone does not come from the runtime's own platform layer.
- A check in each row's handler. Rejected because a row could skip it and a path the table lacks would never reach it.

## Consequences

- A request the router cannot prove is the developer's is refused: an unreadable socket list, an `lsof` that is missing, fails or takes longer than 2 s, a caller end at another address, or a closed caller end, which the kernel lists under uid 0.
- Another user gets `403` on a path the table lacks, where the developer gets `404` (ADR 0001).
- A process of the same user passes, a container run as that uid included. The check keeps other users out, not the developer's own processes.
- Linux reads only `/proc/net/tcp`, so a caller on an IPv6 socket, such as one connected to `::ffff:127.0.0.1`, is refused. Every harness connects to `127.0.0.1` over IPv4.
- The router reads the kernel's addresses as little-endian, which every machine it runs on is. On a big-endian Linux every request would be refused.
- Each file and folder the router writes under the XDG state folder is created with mode 0600 or 0700. `tools/route/private.e2e.test.ts` runs the router under umask 000 and fails on any other mode, and the wire run checks the XDG state and config folders the same way.
