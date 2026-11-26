# Session commands ask the running router

`phi-router status --session <id>` asks the router on the product port over loopback: `GET /phi-router/status?session=<id>`. When no router answers, the command exits 1, prints why, and launches nothing.

We chose this because the router is the one writer of the verdict store and the lease registry (ADR 0005). `status` reports what only the running router knows: the policy version of its judge model, its accounts, and the lane log it writes.

The session pin, which `phi-router pin` and `unpin` set through `POST /phi-router/pin`, is gone. The model `phi/sealed`, the pinned subagent and a BAA repo already run work wholly on the sealed lane, and no session on the owner's machine had been pinned.

## Considered options

- `status` reading the files when no router answers. Rejected because it would count verdicts of a policy version the router no longer uses, and it would answer for a session no router protects.

## Consequences

- A protected session always has a router, so its harness and the commands it runs always reach one.
- `status` counts verdicts under the router's policy version. A store file of another version counts as empty.
- The status answer and the store files carry no pin. A store file the old code wrote still loads: the router ignores its `pinned` key, routes the session by its verdicts, and drops the key on its next write. A harness window or a router released before the pin's removal cannot read the status answer or a store file this router wrote, by choice, since no session used the pin.
- A pinned request judges nothing and stores no verdict. Its parts are judged on the first request that is not pinned, before that request's lane is chosen.
- The lane log gets one line per request. The router opens the log before the first send, so a log that cannot be opened fails the request before any account sees it. A log that opens but cannot take a byte, as on a full disk, fails only after the send, with no line. The router writes the line once the request's walk across accounts ends. The line names the last account the walk stopped at to send, one whose login could not be made fit included, with the reason `failover` when that is another account than the first it stopped at, or `overflow` when a BAA account answers a request that is not pinned, and `failover` when no account answers it. An open account a sealed request moves past is not one it stopped at. A walk that ends before it stops at any account, as when the store cannot be read, names the account it would have started at with the reason `router failure`, or the reason that pinned it. A request the harness hangs up on still leaves its line, and a resend after a 400 that rejects encrypted reasoning, or after a 401, adds none. A router that crashes during a request leaves no line for it. `status` reads the session's last line and counts its overflows from it.
