# The judge reads a piece without context

The policy can show the judge up to `window` earlier rendered items beside a piece; for a tool result the first is its own call. The policy sets `window = 0`, so the judge reads each piece alone.

We chose this because on the v2 corpus, context caught no leak that judging without it missed, lowered a screenshot's score, and raised the cost of each call.

## Considered options

- A window of one or more items. Rejected for the reasons above.

## Consequences

- `window` is part of the policy version, so raising it makes every stored verdict judged again. Raising it needs a paid eval that shows context catches what judging alone misses.
- The judge's reading rules describe context as earlier content that already cleared. `piecesOf` stubs only parts already sealed, so with a window above 0, a part not yet judged would reach the judge raw as context. That wording and that rendering must be settled before the window is raised.
