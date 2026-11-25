# The root agent stays on the open account, and the router keeps sealed content

A request that is not pinned runs on the clean lane whatever its verdicts. Each sealed part reaches the open account as a stub that carries a handle, and the router keeps the part's content in the sealed store, one 0600 file per session beside the verdict store. The root agent hands work that needs PHI to the pinned subagent by naming handles, the router puts the content back only in a request on the sealed lane, and the subagent's last answer passes the answer check, with up to five rewrites, before the root agent receives it.

We chose this because the earlier lane rule, sealed new content runs on the sealed lane, sent the whole conversation to the BAA account on every request until new content cleared. The BAA account is billed per token, so each such request paid for the full context, and the task passed silently to another model mid-turn, which then wrote the report. The owner asked for this design on 2026-11-20, "pass the sealed message to a delegate that can open it and take it from there", and settled it on 2026-11-25 from his diagram.

## Considered options

- Keep the lane rule and make the stub carry a handle. Rejected because it keeps the cost and the silent hand-over.
- The router redacts every sealed part on its own with a BAA call. Rejected because it pays for parts the root agent never needs read, and adds a second mechanism beside the pinned subagent.
- The router runs the rewrite itself, holding back a pinned reply until it clears. Rejected because the turns it adds never reach the harness transcript, and a subagent that calls a tool mid-rewrite breaks the conversation. The harness runs the loop instead: Claude Code's `SubagentStop` hook, and pi-harness's delegate.
- Keep the sealed store in memory. Rejected because a handle must still open after compaction removes the original part from the transcript, and after a router restart.
- Encrypt the sealed store. Rejected because the harness transcripts on the same disk already hold the same text in plain form.

## Consequences

- The verdict store still never holds content. The sealed store does, and is deleted with it.
- The root agent goes blind on a sealed tool result and must delegate to read it. A whole part seals, so one name in a long output hides all of it.
- The border is still the safety: an answer that passes the answer check is judged again as new content before it reaches an open account.
- The BAA account still runs a whole session on `phi/sealed`, in a BAA repo, for a Codex title request, and on overflow, where it receives the same body with handles.
