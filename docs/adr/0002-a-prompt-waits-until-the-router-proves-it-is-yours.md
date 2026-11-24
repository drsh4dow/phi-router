# A prompt waits until the router proves it is yours

The router's port is fixed and free while no instance runs, so another user on the same machine can bind it first. A run on Linux showed that such a listener reads every request Claude Code 2.1.325 sends, with the prompt text and the bearer token. So before each prompt, the harness adapter asks the listener on `127.0.0.1:47411` to prove it is this user's router, and blocks the prompt when it cannot. The proof is an HMAC of a random nonce and the port under a secret kept in the user's private state folder, which another user cannot read. The HMAC-SHA-256 comes from Effect's `Mac` (`effect/crypto/Mac`), which signs on the runtime's Web Crypto in both Bun and Node, because the lint bans `node:crypto`. The test "computes HMAC-SHA-256 as RFC 4231 test case $case gives it" in `tools/lifecycle/proof.e2e.test.ts` pins it to RFC 4231 test cases 1, 2 and 6, beside the test "is HMAC-SHA-256 of the nonce and the port under the secret's 64 hex digits", which pins the proof to a vector of the project's own. Harness settings and the router name the address as the literal `127.0.0.1`, never `localhost`, because another user can bind `[::1]` on the same port and `localhost` resolves to `::1` first.

Each harness has a place to block a prompt. Claude Code runs a `UserPromptSubmit` command hook with `"onFailure": "block"`. Codex runs a `UserPromptSubmit` hook that exits 2. The pi extension runs the check in its own process before each prompt. A compaction sends the whole conversation, so the same check runs before it, in a `PreCompact` hook with `"onFailure": "block"` in Claude Code, in a `PreCompact` hook that prints `"continue": false` in Codex, which does not stop a compaction on exit 2, and on pi's `session_before_compact` event. The same check can restart a router that crashed, since it runs the `phi-router` CLI.

The Claude Code hook also stops a prompt or a compaction when the session's settings move it off the router. A repository's `.claude/settings.json` can set `ANTHROPIC_BASE_URL` to another address or turn on a provider switch such as `CLAUDE_CODE_USE_BEDROCK`, and the hook sees the session's values in its environment (measured on 2.1.330). The instance is protected when its model address names a router, or when Claude Code's user settings hold a router's address, as `on claude` writes it. The hook then blocks when the session's address differs from the user settings' one, or when one of the seven `CLAUDE_CODE_USE_` provider switches that 2.1.330 reads is on, and it names the setting. It asks the port nothing first.

## Considered options

- Check once, in the session-start hook. Rejected because a Claude Code `SessionStart` hook cannot block a session, and a router that crashes frees the port again in the middle of a session.
- Read the uid that owns the listening socket from `/proc/net/tcp`. It works on Linux, where a run read it, but macOS has no `/proc`.
- Listen on a Unix socket in a private folder. The Claude Code 2.1.325 binary names an undocumented `ANTHROPIC_UNIX_SOCKET` in its strings. How it behaves was not run. Codex and pi document no Unix socket for a provider.
- Serve TLS with a per-user certificate authority. It would protect every request, those sent before the first prompt included. Claude Code documents `NODE_EXTRA_CA_CERTS`, and the Codex 0.166.0 binary reads `CODEX_CA_CERTIFICATE` and `SSL_CERT_FILE`, neither run here. Each harness would trust that authority for every host, and Codex reads it only from an environment variable that no install step can set. The owner decides whether the remaining gap is worth that cost.
- Keep the router running at all times. The owner ruled out a server with no instance.
- Pick a random port per user. Another user can bind every free port.

## Consequences

- A request a harness sends before the first prompt is not checked. Claude Code's warm-up `HEAD /api/hello` carries no credential (measured). Codex fetches its model catalog with the forwarded token, so a listener that holds the port before Codex starts reads that token (inferred).
- A router crash in the middle of a turn leaves the rest of that turn unchecked.
- Each prompt pays for one CLI start and one loopback round trip.
