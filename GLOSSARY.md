# PHI router

The router sends each model request of a coding harness to an open account, with a handle in place of each part that holds PHI, and a pinned request to a BAA account.

## Language

### The product

**PHI**:
For routing, content that holds a complete direct identifier of a real patient or member, such as a full name, an SSN or an MRN. Internal ids, health facts tied only to an internal id, staff and vendor contacts, fragments and counts are not PHI.

**Harness**:
A coding agent program that sends model requests: pi, Claude Code or Codex.
_Avoid_: client, tool

**Instance**:
One running process of a harness.

**Session**:
One conversation in an instance, named by the session id its harness sends with each request. pi sends none of its own, so the pi package adds a session header. The verdict store, the sealed store and the lane log are kept per session.

**Root agent**:
The main agent of a session, the one the user talks to. It runs on the clean lane, never reads PHI, and hands work that needs PHI to the pinned subagent.

**Provider `phi`**:
The provider the pi package adds to pi, at the router's address, with the models `phi/auto` and `phi/sealed`. Only a request of this provider is routed.

**Router**:
The local program that receives every model request of a protected instance and picks its lane.
_Avoid_: gateway, proxy, daemon

**Harness adapter**:
The package that installs the router into one harness the way that harness installs extensions.
_Avoid_: integration, connector

**Release channel**:
Where the newest release always waits: the `release` branch of the phi-router repository for Claude Code and Codex, and the npm package's latest version for pi. A harness adapter installed from it can take each new release in place.
_Avoid_: latest, main

**Held install**:
A harness adapter installed from one release tag or one exact npm version, so it never updates. Setup moves it to the release channel.
_Avoid_: pinned install

**Installed version**:
The version of the harness adapter a harness has on disk, by that harness's own records. Setup never lowers it.

**Protected instance**:
An instance whose model requests go to the router.

**Lease**:
An instance's registration with the router. The router runs only while a lease belongs to a live instance.

**Lease registry**:
The router's leases, stored on disk so a router launched after a crash adopts them. A lease in it holds while its process runs with the start time the lease recorded.

**Port proof**:
The router's answer that shows the listener on its port is this user's router: the HMAC-SHA-256 of a nonce and the port under the secret. A harness adapter asks for it before each prompt and each compaction, and blocks the prompt when the answer does not match.
_Avoid_: handshake, health check

**Router version**:
The release a running router was launched from, read once at launch from the plugin manifest beside its entry and reported in its port proof answer. A router that reports none, such as v0.3.0, counts as older than every release.

**Nonce**:
The 32 random bytes, in hex, that a harness adapter sends with one request for the port proof, so no earlier answer passes.

**Secret**:
The 32 random bytes, in hex, in `phi-router/secret` under the user's XDG state folder, 0600 in a 0700 folder, under which the router computes the port proof. Another user cannot read it.
_Avoid_: key, token

### Accounts and lanes

**Vendor**:
The company whose wire an account speaks: Anthropic, for Claude Code's Messages requests, or OpenAI, for Codex's Responses requests.

**Account**:
One credential for one model vendor.

**Credential**:
How an account authenticates: a forwarded login, a key the router reads from its key source, or a login folder.

**Forwarded login**:
The login the harness sends with each request, which the router passes on to the account.

**Key source**:
Where the router reads a key: an environment variable, a command that prints the key, or the absolute path of a key file. `config.json` holds the key source, never the key.

**BAA account**:
An account under a business associate agreement, whose models may read PHI.

**Key check**:
What a vendor answered when setup asked whether it takes a pasted API key: **accepted**, a 2xx; **refused**, a 401 or 403; or **unanswered**, any other status, a timeout or a transport error.

**Open account**:
An account outside any BAA.
_Avoid_: personal account, personal provider

**Clean lane**:
The ordered list of open accounts, where every request that is not pinned runs.

**Sealed lane**:
The ordered list of BAA accounts, where a pinned request runs, a request the clean lane refused, and a request no open account took.

**Home account**:
The open account a session's clean lane tries first.

**Walk**:
The accounts one request may still try, in order: the open accounts from its home account on, without the stamped ones, then the BAA accounts that carry its target model, then those that lack it. It only shrinks.

**Failover**:
A request moving to the next account of its walk on a 429, a 5xx, no answer or an ended login, before the first byte of the answer. It moves from the clean lane to the sealed lane, never back.

**Overflow**:
A request, not pinned, that a BAA account answers because no open account took it: each was stamped, did not answer, or its login ended. It carries the same stubs and handles the open account would have received. At the end of a turn with an overflow, the harness says why and how to add a subscription, once per stamp, or once per 30 minutes when no stamp explains it.

**Stamp**:
The mark a 429 leaves on an open account. The clean lane skips the account for 30 minutes.

**Login folder**:
The folder where a vendor's CLI keeps one account's login: Claude Code's `CLAUDE_CONFIG_DIR` or Codex's `CODEX_HOME`. The router reads its token on each send and the vendor CLI refreshes it.

**Ended login**:
A login folder that holds no token its vendor's CLI can still renew, or no login at all. A request fails over from its account, and the router names the vendor command that logs in again.

**Target model**:
The model a request names.

**`phi/auto`**:
The model name that stands for the target model the router's configuration names for the harness's vendor.

**Model catalog**:
The list of models an open account offers a harness, which the router serves with `phi/auto` added.

**`phi/sealed`**:
The model name that pins every request that carries it. A request on it runs the configured sealed model. In pi it is the model `sealed` of the provider `phi`.

**Substitute**:
The model that runs a sealed request when no BAA account carries the target model.

### Policy and verdicts

**Policy**:
The rules and the judge's questions that say what is PHI, versioned as one unit.

**Rule**:
A deterministic pattern for an unambiguous direct identifier. A rule seals and never clears.

**System One model**:
An AI model built to make fast, structured decisions that software uses directly: it evaluates a state and returns typed answers and probabilities. OpenAI's Decisions API, TypeSafe AI's Jev and Cloudflare's Clef are System One models, and a model that generates text, such as Claude Haiku, is not one however small or fast it is.
_Avoid_: small model, fast model

**Judge**:
The System One model that scores whether a piece holds PHI when no rule sealed it. It runs under a BAA on **Decisions**, OpenAI's Decisions API, the only judge phi-router offers (ADR 0014). The file's `judge` block runs it on a key of its own. With no `judge` block, the first OpenAI API-key account on `sealed` runs it.
_Avoid_: classifier, scanner

**Part**:
One unit of a request that the border can replace on its own: a message, a system section or the tool list.

**Piece**:
A part as the policy reads it: its kind, its text and its images.

**Content key**:
A hash of one part's role and content, the name its verdict is stored under.

**Verdict**:
What the router concluded about one part: **sealed**, it holds PHI, or **cleared**, it does not.

**New content**:
The parts of a request from its last reply on: that reply and every part after it. The router judges them.

**Seam**:
The end of the previous message of the same role, read in front of a message that goes on from it mid-word.

**Fixture**:
A part whose exact text the configuration lists, so the policy skips it.

**Policy version**:
A hash of the policy, the judge, its thresholds and its model. A verdict stored under another policy version is ignored and its part judged again.

**Verdict store**:
One file per session id that holds the session's content keys with their verdicts, its reply keys and the policy version. It never holds content.

**Standing**:
A part's verdict as one read of the verdict store gives it: sealed, cleared, or unknown when the store holds no verdict for its key.

**Reply key**:
The content key of a reply an open account streamed to the end, kept in the verdict store so that reply is checked by the rules alone.

**Lane choice**:
The lane the router sends one request on, by the lane rule. The border never relies on it.

### The border

**Stub**:
The text an open account receives in place of a part that is sealed or not yet judged. A sealed part's stub carries its handle.

**Handle**:
The id in a sealed part's stub, such as `h3`, by which the root agent names that part to the pinned subagent. It reveals nothing of the content. Only a pinned request, or a request the clean lane refused, opens it, and an overflow keeps it closed.
_Avoid_: token, reference, pointer

**Sealed store**:
The content of each sealed part and each withheld answer of a session, kept by the router under its handle, so the pinned subagent can read it after compaction or a router restart.
_Avoid_: sealed DB, vault

**Border**:
The check on every request bound for an open account, which passes cleared parts and stubs the rest.

**Pin**:
What runs a request on the sealed lane with nothing judged: the model `phi/sealed`, the pinned line, a BAA repo or a title request.

**Pinned subagent**:
A subagent started on `phi/sealed`, to which the root agent hands one scoped task that needs PHI: redacting a sealed part, or the segment of the work that needs its identifiers. Claude Code names it `phi-router:phi-sealed` and Codex `phi-sealed`. In pi-harness it is a delegate on `phi/sealed`. Stock pi has none.
_Avoid_: sealed subagent

**Pinned instructions**:
The block the router adds to the system prompt of a request on `phi/sealed` or with the pinned line, built from the policy: its definition of PHI, what does not count, how to answer without identifiers, and the limit of five rewrites.

**Answer check**:
The rules and the judge reading the pinned subagent's last answer before the root agent receives it. Claude Code and pi-harness run it, Codex does not.

**Rewrite**:
Sending a sealed answer back to the pinned subagent with what sealed it, why the root agent must not see it, the attempt out of five, and how to answer instead: internal ids, counts, or a file in the files folder.

**Withheld answer**:
The pinned subagent's answer that was still sealed after five rewrites. The router keeps it in the sealed store under a handle, and the root agent receives only the handle and a line saying the answer could not be cleared.
_Avoid_: dropped answer

**Files folder**:
The private folder of a session under `phi-router/files/` in the user's XDG state folder, where the pinned subagent writes the patient identifiers the user needs. The router never deletes it.

**Pinned line**:
The first line of the pinned subagent's instructions, `phi-router: pinned subagent.`. A request whose system prompt holds it is pinned whatever model it names.

**BAA repo**:
A repository whose sessions run wholly on the sealed lane.

**Title request**:
Codex's request that names a thread, marked by `thread_source: "thread_title"` in its turn metadata. It runs sealed with the reason `title`, with no judge call and no bridge.

**Status line**:
The line Claude Code shows below its prompt, which `phi-router statusline` fills with the session's last request, its sealed and cleared counts, and its pinned subagent runs, only while a phi model is picked. pi shows the same in its status bar.

**Lane log**:
One line per routed request, which never holds content. Its reason says why the request ran on its lane: `clean`, not pinned; `pinned`, the model `phi/sealed` or the pinned line; `BAA repo`; `title`, a title request; `failover`, it ended at another account than its first, or no account answered a request that is not pinned; `overflow`, see Overflow; `router failure`, the router could not build its clean body, or the request failed before its walk reached an account.

**Bridge**:
The fixed block, one per harness, that the router adds to the system prompt of every request that is neither pinned nor a title request, on both lanes. It tells the root agent what a handle is and when to start the pinned subagent.

### Verification

**Canary**:
A synthetic identifier planted in a test corpus, so a check can search request bodies for it. Never real PHI.

**Corpus**:
The generated set of synthetic conversations with canaries that the leak gate runs on.

**Case**:
One conversation of the corpus, PHI or clean.

**Capture**:
The bytes of one request or reply recorded off a real harness binary, kept as a fixture.

**Harness note**:
A system-role message a harness puts inside `messages`, such as Claude Code's environment block.

**Attribution block**:
Claude Code's first system block, its billing header. The router neither judges nor stubs it.

**Dialect**:
How a Codex request sends its tools: lite puts them in an `additional_tools` item, fallback in the top-level `tools`.

**Reply run**:
The items of one earlier reply that Codex sends back, read as one assistant message.

**Turn metadata**:
The `x-codex-turn-metadata` value Codex sends with each turn.

**Mock upstream**:
A loopback test server that stands for the open account, the BAA account or the judge and records each request.

**Wire run**:
`bun run wire <harness>`, which drives the real harness binary through the router against mock upstreams and checks what each mock received.

**Leak**:
A complete canary in any one message sent to an open account.

**Check**:
One line of `phi-router doctor`'s report: a claim about the installation, and whether it holds.
