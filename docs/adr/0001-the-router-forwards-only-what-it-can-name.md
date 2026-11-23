# The router forwards only what it can name

The router serves a fixed list of paths and answers every other path with 404. It sends an upstream only the parts of a request and a fixed list of fields that hold no session content. A top-level field it does not know fails the request with an error that names the field. A block it cannot read, such as an unknown block type, encrypted reasoning or redacted thinking, makes its part unjudged, so the border stubs it on the clean lane unless the open account itself wrote that reply.

We chose this because the harnesses already send session content to the router outside the one path it judges. Claude Code posts whole messages to `/v1/messages/count_tokens`, and Codex can post memory traces to `/memories/trace_summarize` on the provider's address. A harness upgrade can add a field or a path at any time. A router that relays what it does not know turns each such change into a silent leak, while one that refuses it turns the change into a visible error that the wire run catches.

## Considered options

- Relay unknown paths and fields unchanged, as a general gateway does. Rejected because the failure is a leak that nobody sees.
- Judge an unknown top-level field as one more part. Rejected because the codec cannot know how to stub a field whose meaning it does not know, so the stub could break the request or keep the content.

## Consequences

- A harness upgrade that adds a field stops the router until the codec learns the field. The wire run against the new binary shows which field.
- Encrypted reasoning that a BAA account returned never reaches an open account, even where that account could read it. If dropping it breaks a session, the session breaks and does not leak.
- A request the clean lane cannot carry in its named shape (`CleanLaneRefused`), or whose tool list never cleared (`ToolsNotCleared`), runs on the sealed lane, decided before any byte is sent.
- The router keeps the keys of the replies an open account streamed, with the session's verdicts. A reply whose key it holds is checked by the rules alone. Losing a key costs a judge call and cannot pass content.
