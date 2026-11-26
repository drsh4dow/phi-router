# A running router keeps the port until its last window closes

The router lives as long as its leases (ADR 0005), so after a plugin update the router an earlier window launched keeps the port, and each new window's `start` proves it and joins it. The new release's rules run once every window has closed. We keep it that way: a `start` never stops a running router. It tells the session instead.

The proof answer carries the router version beside the HMAC: `{"proof":"<hex>","version":"0.4.0"}`. The router reads it once at launch from the plugin manifest beside its entry, `.claude-plugin/plugin.json`, because the Claude Code and Codex plugin caches hold no `package.json`. A missing or malformed version reads as older than every release. The key sits outside the HMAC, so a v0.2.0 or v0.3.0 `start`, whose schema ignores it, still proves a newer router. Versions compare by semver precedence (`src/router/primitives/release.ts`).

When a `start`'s plugin is newer than the router it proved, it joins that router and the session learns of the wait: "phi-router 0.5.0 is installed. Your open windows still run 0.4.0 until you close them all." Claude Code and pi show it in the status line as `· 0.5.0 pending` and in full in `/phi`, both from the launcher's `statusline`, which asks the router its version. They never show it in the conversation: phi-router speaks there only through the status line and `/phi`. Codex has no status line, so its `SessionStart` hook prints the line as a `systemMessage`. A plugin of the router's version or older says nothing.

## Considered options

- A newer `start` sends the old router SIGTERM, waits for the port to come free, and launches its own router. Rejected because the port is free in that gap, and any local program can bind `127.0.0.1:47411` without privilege. A run with the real Claude Code showed it: a window mid-reply sent its request again to a listener that bound the free port, prompt text and bearer token included (2 requests there, 0 on main). The port proof runs before each prompt, not before Claude Code's own resend. The same design also let a newer `start` that lost the bind to an older router leave the port empty.
- Drain the router on SIGTERM. Dropped with the handover. The router exits on its own only when no lease holds, and then no window has a reply in flight.

## Consequences

- An update takes effect once the user has closed every protected window, and the line says so.
- A window on an older plugin that meets a newer router joins it and works as before.
- A `SessionStart` hook's stdout reaches the harness, so the CLI reports a failure it does not catch on stderr, not with the runtime's logger on stdout.
- Claude Code 2.1.332 shows a `SessionStart` `systemMessage` in the transcript, and puts plain stdout or `additionalContext` into every request as a `<system-reminder>`, measured against a mock. So Claude Code's `SessionStart` hook sends `session-start --claude` to stderr, and prints nothing.
