# One local router owns the HTTP for all three harnesses

Every protected instance of pi, Claude Code and Codex sends its model requests to one local router on `127.0.0.1:47411`. The router decodes the request, judges it, picks the lane, rewrites the body for an open account, calls the account itself and streams the reply back unbuffered. No harness makes the upstream call, and no harness-specific code decides a lane or applies the border.

We chose this because two of the three harnesses leave no other place to stand. Claude Code and Codex expose no in-process hook that sees or rewrites a model request, a Claude Code plugin cannot set the model address, and a Codex plugin cannot add a provider. Both document one setting that sends every model request to a local endpoint with the subscription login forwarded. In the original pi harness the router only picked a provider and pi made the call, which works in pi alone. With the router making the call, the same code path carries all three, so one wire run, one border test and one formal model cover every harness.

## Considered options

- An in-process router per harness, as the pi harness has. Rejected because Claude Code and Codex offer no hook for it, and three implementations would need three proofs.
- A router that only answers "which lane" while the harness calls the account. Rejected because the harness would hold the unstubbed body and the open account's credential in the same call, so the border would rest on harness code the router cannot check.
- A shared company server. Out of scope. The router binds loopback on the developer's machine.

## Consequences

- The router is on the path of every byte, so it must stream. It relays an upstream's body chunk by chunk, `ping` events included, and passes an error answer unchanged once its walk has no account left (`tools/route/streaming.test.ts`, `tools/route/lanes.test.ts`). Before that, a 429 or a 5xx is a failover: the router leaves its body unread, closed with the request, and sends to the next account before any byte reaches the harness (`tools/route/failover.test.ts`).
- A router that is down fails the harness's requests. Nothing falls back to a direct call.
- The router handles two credentials on one request. A keyed account never receives the credential the harness sent, and that swap lives in one file, `src/router/client/upstream.ts`.
- An account can name an `endpoint`. Without one it is the vendor's own address. The mocks, the wire run and a company gateway are reached this way.
- The entry file imports `createServer` from `node:http`, the one builtin the gates allow it, because Node's server layer takes it. The dependency-cruiser rule `entry-builtins` still bans every other builtin there, and one `.oxlintrc.jsonc` override lifts the two lint rules for that file alone.
- The loopback port is the attack surface ADR 0002 covers.
