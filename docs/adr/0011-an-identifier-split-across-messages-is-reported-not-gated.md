# An identifier split across messages is reported, not gated

The leak gate fails on a complete canary in any one message an open account receives. A canary whose parts reach open accounts only in separate messages is a split: the corpus eval reports it apart from the leaks, and it never fails the gate. A message that holds the canary whole, or holds all of its parts, makes it a leak whatever the case's label. Some of its parts alone are fragments, reported and never a leak.

The owner set this release gate in the design: "The release gate is zero complete direct identifiers in any one message on the wire to [the open account]. An identifier split across a message boundary … is an accepted risk: reported, not gated." The border judges and stubs each part on its own, and the policy counts a fragment as not PHI, so no one message of a split holds PHI by the policy's own definition. A gate on splits would fail on content that the border is not built to see.

## Considered options

- Gate a split like a leak. Rejected: passing it would need the router to judge parts together and seal fragments, which the policy says are not PHI, and every such seal moves a request to the sealed lane.

## Consequences

- `tools/corpus/seen.ts` sorts each split canary by the messages that carried its parts into whole, split, partial or none. Only whole counts as a leak.
- `bun run eval:recorded` prints the split cases under "Identifiers split across messages, an accepted risk, reported and not gated", and its exit code ignores them.
- The corpus keeps planting split cases, so the report shows how often a split reaches an open account.
