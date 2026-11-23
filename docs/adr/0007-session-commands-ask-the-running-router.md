# Session commands ask the running router

`phi-router pin`, `unpin` and `status --session <id>` ask the router on the product port over loopback: `POST /phi-router/pin` with `{session, pinned}`, and `GET /phi-router/status?session=<id>`. When no router answers, the command exits 1, prints why, and launches nothing. The router reads the pin once when a request arrives, so a pin change never moves a request already in flight.

We chose this because the router is the one writer of the verdict store and the lease registry (ADR 0005). The store's sealed-wins merge is a lock inside one process, so a second process that wrote the pin would race it. `status` reports what only the running router knows: the policy version of its judge model, its accounts, and the lane log it writes.

## Considered options

- `pin` writing the session's store file itself. Rejected because a write from a second process can lose a verdict the router stores at the same time.
- `pin` keeping its own file the router reads. Rejected because a request would then read two files on arrival, and a crash between them leaves the pin and the verdicts out of step.
- `status` reading the files when no router answers. Rejected because it would count verdicts of a policy version the router no longer uses, and it would answer for a session no router protects.
- `pin` launching a router as `start` does. Rejected because a pin is for a session that runs, and that session's own `start` launches the router.

## Consequences

- A protected session always has a router, so its harness and the commands it runs always reach one.
- `status` counts verdicts under the router's policy version. A store file of another version counts as empty, its pin kept.
- `pin` and `unpin` print nothing on success. Setting the pin to the value it holds changes nothing.
- A pinned request judges nothing and stores no verdict. Its parts are judged on the first request after `unpin`, before that request's lane is chosen.
- The lane log gets one line per request. The router opens the log before the first send, so a log that cannot be opened fails the request before any account sees it. A log that opens but cannot take a byte, as on a full disk, fails only after the send, with no line. The router writes the line once the request's walk across accounts ends. The line names the last account the walk stopped at to send, one whose login could not be made fit included, with the reason `failover` when that is another account than the first it stopped at. An open account a sealed request moves past is not one it stopped at. A walk that ends before it stops at any account, as when the store cannot be read, names the account it would have started at with the reason `router failure`, or the pin. A request the harness hangs up on still leaves its line, and a resend after a 400 that rejects encrypted reasoning, or after a 401, adds none. A router that crashes during a request leaves no line for it. `status` reads the session's last line from it.
