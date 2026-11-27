# The router answers only the user who runs it

Every request to the router passes one check before its path is matched or its body is read. The router looks up the two ends of the request's TCP connection in the machine's list of sockets and serves the request only when one uid holds both: the caller's end and the router's own end. Anything else gets `403` with an Anthropic-shaped `permission_error`, and reaches no account and no judge. The check is the `middleware` of the HTTP server in `src/router/client/router-port/server.ts`, so every row of the path table, the lease row and any row a later ticket adds sit behind it with no code of their own. `src/router/client/router-port/callers.ts` owns the lookup.

We chose this because the router holds the developer's credentials and state, and any user of the machine can connect to `127.0.0.1`. The kernel already knows who holds each socket, so the router asks it and the harnesses change nothing. The router's own end carries the router's uid, so the router never asks for its uid, and source code names no `process`.

- **Linux.** `/proc/net/tcp` lists every IPv4 TCP socket of the network namespace with the uid that holds it, each user's included. The router reads it once per request and matches both ends by address and port.
- **macOS.** There is no `/proc`. The router runs `lsof -nP -iTCP@<router end> -Fun`, which prints each process's uid and each connected socket. A user who is not root sees only the sockets of their own processes there, so another user's end is never listed and the request is refused. This was not run on macOS. It was run on Linux, where `lsof` behaves the same for a user who is not root.
- **Windows.** The router knows it runs on Windows when the platform's path separator is `\`. The owner is the account of the process that holds each end. The router runs `netstat -ano -p TCP`, which lists every IPv4 TCP connection with its owning process id, keeps the rows whose local and remote ends are the request's two ends, and runs `tasklist /v /fo csv /nh /fi "PID eq <pid>"` once for each process id they name, all at once. The owner is the `DOMAIN\name` that tasklist prints for that process. Both tools run from `%SystemRoot%\System32` (`C:\Windows` when the variable is unset) by absolute path, so no program earlier on `PATH` can answer for them: on the machine this was built on, `whoami` on `PATH` resolved to Git's copy. The same rule then applies: a caller end must be listed, the router's own end gives the expected owner, and every listed row on either end must carry it.

### Why netstat and tasklist on Windows

Measured on Windows 10 22H2 with a loopback pair held by one process, five runs each: `netstat -ano -p TCP` took 31–46 ms, `tasklist /v` filtered to one process id 158–192 ms, `wmic process ... GetOwnerSid` 287–396 ms, PowerShell `Get-CimInstance Win32_Process` with `GetOwnerSid` 612–832 ms, and PowerShell `Get-NetTCPConnection` 963–1513 ms. The whole check, netstat and then two tasklists side by side, took 223–370 ms under Bun and 179–248 ms under Node, inside the 2 s limit with room to spare.

- The owner's SID would be the stronger name, but no fast way gives it. `wmic` is deprecated and missing from newer Windows by default, and PowerShell pays its own start on every request, near the limit on a busy machine. Reading the SID through `OpenProcessToken` needs FFI, which the router cannot use: `bun:ffi` is a builtin the boundaries gate bans, and the router also runs under Node.
- The account name is a safe stand-in because Windows prints it from the SID in the process's token, and one `DOMAIN\name` names one account at a time. The router compares the printed bytes: an owner with a byte the UTF-8 decoder could not read is refused, so two names in the console's code page never decode to the same text.

### What Windows refuses

- A process of another account. A user who is not an administrator cannot open it, and tasklist prints `N/A` (seen for `SYSTEM`, `DWM-1` and service processes here), which carries no `\` and is refused. An administrator sees the other account's name, which differs, and is refused too.
- Process id 0, the owner netstat gives a closed `TIME_WAIT` end. tasklist names it `NT AUTHORITY\SYSTEM`, so the router never asks and refuses it.
- A row netstat does not list, a process tasklist does not find, a tasklist that prints more than one row for the id, a row for another id, a netstat or tasklist that exits non-zero or cannot start, and a check that takes longer than 2 s.
- A caller on IPv6. `-p TCP` lists IPv4 only, so a caller at `::1` or `::ffff:127.0.0.1` matches no row. Every harness connects to `127.0.0.1`.

### The caller token on Windows

- On Windows the owner check alone leaves a gap: a socket can outlive the process id netstat lists for it.
- To close it, every request except `/api/hello` and the port proof must also carry `x-phi-router-caller`.
   - The header holds a 64-hex token that `serve` creates at `<state>/phi-router/caller-token` before it listens.
   - The token file is written through `writePrivately`, so its DACL names only the current user.
   - `phi-router claude on` writes the header into `ANTHROPIC_CUSTOM_HEADERS` in Claude Code's `settings.json`, after any headers the developer set. Claude Code sends it on every `POST /v1/messages`. `phi-router claude off` removes only that line.
- The router checks the token before it lists processes, so a request without it costs no netstat or tasklist.
   - It compares an HMAC of the presented token against an HMAC of the stored one, so the comparison takes the same time either way.
   - A missing or wrong token gets 403, and so does a token file the router cannot read.
- `/api/hello` is exempt because Claude Code sends it without custom headers. It still passes the owner check.
- The port proof is exempt from the token, not from the owner check. Its answer is an HMAC of the caller's own nonce, so it gives a caller nothing.
- A client sends the token only to a listener that passed the port proof on that port, so a listener that took the port first (ADR 0002) never receives it. On Windows each session and lease request therefore asks for the proof first. `Proofs.callerHeaders` in `src/router/client/router-port/proof.ts` is the one place that turns a proven port into the header.
- On Linux and macOS no token is created, sent or checked.

### What a private file's DACL may name on Windows

- A file or folder the router writes is private when its DACL is protected and its only ACEs grant full access to the current user, to SYSTEM (`SY`) or to the local Administrators group (`BA`).
- SYSTEM and an elevated administrator can read every file anyway, through their backup and take-ownership privileges. A GitHub Actions runner leaves both ACEs on files its built-in Administrator creates.
- `icacls /save` prints the built-in Administrator account (RID 500) as `LA`, not as its SID, so the router treats `LA` as that user.
- Any other account, `Everyone` included, makes the router refuse the file.

## Considered options

- A per-user secret in a header, set by `on claude`, `on codex` and the pi extension. Rejected on Linux and macOS because it needs every harness's settings to carry a secret and the CLI to write it, where the socket list needs no setting at all. Adopted on Windows, for Claude Code only, because there the socket list cannot rule out a socket that outlives its process id (see the caller token above). The proof path is exempt, and a client sends the token only after a proof.
- `lsof` on Linux too. Rejected because a machine without `lsof` would refuse every request, and each request would pay a subprocess where reading `/proc/net/tcp` takes a few milliseconds.
- Keep Bun's own HTTP server. Rejected because Effect's request carries the caller's address but not its port, and Bun's server keeps the port in a private field. The entry file now builds Node's `http` server on both runtimes, so `request.source.socket` names both ends. Bun runs Node's server through its own compatibility layer. So HTTP alone does not come from the runtime's own platform layer.
- A check in each row's handler. Rejected because a row could skip it and a path the table lacks would never reach it.

## Consequences

- A request the router cannot prove is the developer's is refused: an unreadable socket list, an `lsof` that is missing, fails or takes longer than 2 s, a caller end at another address, or a closed caller end, which the kernel lists under uid 0.
- Another user gets `403` on a path the table lacks, where the developer gets `404` (ADR 0001).
- A process of the same user passes, a container run as that uid included. The check keeps other users out, not the developer's own processes.
- Linux reads only `/proc/net/tcp`, so a caller on an IPv6 socket, such as one connected to `::ffff:127.0.0.1`, is refused. Every harness connects to `127.0.0.1` over IPv4.
- The router reads the kernel's addresses as little-endian, which every machine it runs on is. On a big-endian Linux every request would be refused.
- On Windows the list and the owners are read apart, so a process id could be reused between netstat and tasklist. A same-user process that ends and whose id another account's new process takes in those milliseconds would give that account's owner, which is refused. The reverse needs a socket of another account that outlives the process id netstat lists for it, as when a child process inherited it, and a new process of the developer's that takes that id in the same window. The owner check does not rule that out, so the caller token does: that process cannot read the developer's token file. Each request pays about 200–400 ms for three short processes.
- Each file and folder the router writes under the XDG state folder is created with mode 0600 or 0700. `tools/route/private.e2e.test.ts` runs the router under umask 000 and fails on any other mode, and the wire run checks the XDG state and config folders the same way.
