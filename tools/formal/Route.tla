------------------------------- MODULE Route -------------------------------
(***************************************************************************)
(* The requests inside one router: the verdicts it stores, the lane it     *)
(* picks, what the border lets through to an open account, and the pin.    *)
(* Properties (a), (b), (c) and (e). Lifecycle.tla holds (d).            *)
(*                                                                         *)
(* The harness is free. A request carries any of its session's parts as   *)
(* history and any as new content, pinned or not, at any time. So a turn, *)
(* a subagent, a background request, a resume and a fork are all covered  *)
(* without a model of the transcript, and the properties hold whatever    *)
(* the parts feature computes as new content.                              *)
(*                                                                         *)
(* The judge is free too. Each judgment answers sealed or cleared, and two *)
(* judgments of one part may disagree. A rule hit, the quote rule and a    *)
(* failed judgment are all "the answer was sealed".                        *)
(*                                                                         *)
(* Each action is one step the code takes without an await inside it.     *)
(* .agents/skills/verify-formal-model/SKILL.md names the code behind each. *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences, TLC

CONSTANTS
    Sessions,      \* the sessions, each written as the set of content keys of its parts
    Slots,         \* the requests one session can have inside the router at once
    OpenAccounts,  \* how many open accounts the clean lane lists
    BaaAccounts,   \* how many BAA accounts the sealed lane lists
    MaxNew,        \* the most parts one request carries as new content
    MaxHistory,    \* the most parts one request carries as history
    Lacking        \* the BAA accounts that lack the target model every request names

VARIABLES
    store,       \* the verdict stores: store[k] is "sealed", "cleared", or "none" while k is unjudged
    request,     \* request[s][i]: a request of session s inside the router, lost in a router crash
    sealedOnce   \* the content keys stored as sealed in this policy version; only VerdictNeverUnseals reads it

vars == <<store, request, sealedOnce>>

\* No two sessions share a content key. Each session has its own verdict store
\* and nothing compares two stores, so a key names one part of one session.
Keys == UNION Sessions

Free == [phase |-> "free"]

\* What a request carries: its history, and the new content from the last
\* assistant message on.
Contents(s) ==
    {c \in [history : SUBSET s, new : SUBSET s] :
        /\ c.new # {}
        /\ c.history \cap c.new = {}
        /\ Cardinality(c.new) <= MaxNew
        /\ Cardinality(c.history) <= MaxHistory}

Parts(q) == q.history \cup q.new

\* The accounts of a set in ascending order.
Ascending(S) == [n \in 1..Cardinality(S) |-> CHOOSE a \in S : Cardinality({b \in S : b < a}) = n - 1]

\* A request inside the router, as it arrives.
Request(phase, c, pinned, sealed, cleared) ==
    [phase |-> phase, history |-> c.history, new |-> c.new,
     pinned |-> pinned, sealed |-> sealed, cleared |-> cleared,
     lane |-> "none", account |-> 0, body |-> <<>>, sealedNew |-> FALSE, wasSealed |-> FALSE,
     spent |-> FALSE, resentHere |-> FALSE, substitute |-> FALSE, triedBaa |-> {}]

\* A request that failed at the harness. The harness can send its parts again.
Failed(q) == Request("failed", [history |-> q.history, new |-> q.new], FALSE, {}, {})

-----------------------------------------------------------------------------
(* The design's steps, one operator each. A configuration under breaks/   *)
(* swaps one for a broken variant at the end of this module.              *)

\* The parts a request has judged: every part with no stored verdict, history
\* included, as the lane rule needs: "A sealed part in the new content,
\* or a part sealed during this request, sends it to the sealed lane."
ToJudge(c, verdicts) == {k \in c.history \cup c.new : verdicts[k] = "none"}

\* Storing a verdict never unseals: a sealed verdict stays, whatever is written after it.
Merge(old, fresh) == IF old = "sealed" THEN "sealed" ELSE fresh

\* The lane rule. A pin, a part this request's judgments sealed, or a sealed
\* part in the new content sends the request to the sealed lane.
Lane(q, verdicts) ==
    IF \/ q.pinned
       \/ q.sealed # {}
       \/ \E k \in q.new : verdicts[k] = "sealed"
    THEN "sealed"
    ELSE "clean"

\* Whether the account a send goes to has spent its 401 resend: what the
\* request's current account had when the send stays there, and unspent when
\* the send moves to another account.
Allowance(q, to) == IF to.lane = q.lane /\ to.account = q.account THEN q.spent ELSE FALSE

\* Whether a send names the substitute: it goes to a BAA account that lacks
\* the request's target model. An open account runs every model.
Substitute(q, to) == to.lane = "sealed" /\ to.account \in Lacking

\* The order of the sealed lane's walk: the BAA accounts that carry the
\* target model, then those that lack it, each in the file's order.
BaaWalk == Ascending((1..BaaAccounts) \ Lacking) \o Ascending(Lacking)

\* The border. Of a request's parts, an open account receives the cleared ones
\* as they are and the stub in place of every other one.
Passes(k, verdicts) == verdicts[k] = "cleared"

\* The account a request tries after its account fails before the first byte.
\* Past the clean lane's last account comes the sealed lane's first in its walk.
\* Past the sealed lane's last account in its walk the request fails.
NextAccount(lane, account) ==
    LET place == IF lane = "sealed" THEN CHOOSE n \in 1..BaaAccounts : BaaWalk[n] = account ELSE 0
    IN  IF lane = "clean" /\ account < OpenAccounts THEN [lane |-> "clean", account |-> account + 1]
        ELSE IF lane = "clean" THEN [lane |-> "sealed", account |-> BaaWalk[1]]
        ELSE IF place < BaaAccounts THEN [lane |-> "sealed", account |-> BaaWalk[place + 1]]
        ELSE [lane |-> "failed", account |-> 0]

-----------------------------------------------------------------------------

\* What a send to an open account carries for each part: "stub", or the part
\* itself tagged with the verdict the store held for it when it left.
Body(q, verdicts) == [k \in Parts(q) |-> IF Passes(k, verdicts) THEN verdicts[k] ELSE "stub"]

\* One send to one account. It reads the verdict store once: the lane rule can
\* move the request from the clean lane to the sealed lane, never back, and the
\* body is built from the same verdicts.
Send(s, i, q, lane, account) ==
    LET to == IF lane = "clean" /\ Lane(q, store) = "sealed"
              THEN [lane |-> "sealed", account |-> BaaWalk[1]]
              ELSE [lane |-> lane, account |-> account]
        sealedNew == \E k \in q.new : store[k] = "sealed"
    IN  request' = [request EXCEPT ![s][i] =
           [q EXCEPT !.phase = "sent", !.lane = to.lane, !.account = to.account,
                     !.sealed = {}, !.cleared = {},
                     !.body = IF to.lane = "clean" THEN Body(q, store) ELSE <<>>,
                     !.sealedNew = q.sealed # {} \/ sealedNew,
                     !.wasSealed = q.wasSealed \/ to.lane = "sealed",
                     !.spent = Allowance(q, to),
                     !.substitute = Substitute(q, to),
                     !.triedBaa = IF to.lane = "sealed" THEN q.triedBaa \cup {to.account} ELSE q.triedBaa,
                     !.resentHere = q.resentHere /\ to.lane = q.lane /\ to.account = q.account]]

\* A request arrives, and the router judges every part of it that has no
\* stored verdict. The answers stay in memory. The pin is read here, once: the
\* session's pin, the model phi/sealed, the pinned subagent's line in the
\* system prompt, a BAA repo, or Codex's thread-title request. A pinned
\* request judges nothing.
Arrive(s, i, c, pinned) ==
    LET todo == IF pinned THEN {} ELSE ToJudge(c, store)
    IN  /\ \E sealed \in SUBSET todo :
              request' = [request EXCEPT ![s][i] = Request("judged", c, pinned, sealed, todo \ sealed)]
        /\ UNCHANGED <<store, sealedOnce>>

Init ==
    /\ store = [k \in Keys |-> "none"]
    /\ request = [s \in Sessions |-> [i \in Slots |-> Free]]
    /\ sealedOnce = {}

\* A turn of the conversation: every part of its history has a stored verdict.
Prompt(s, i, c, pinned) ==
    /\ request[s][i] = Free
    /\ \A k \in c.history : store[k] # "none"
    /\ Arrive(s, i, c, pinned)

\* The harness rewrote its transcript, as a compaction does: the history holds
\* a part the router never judged, such as the summary. It gets no special path.
\* The first request after an unpin or a lost verdict looks the same.
Compaction(s, i, c, pinned) ==
    /\ request[s][i] = Free
    /\ \E k \in c.history : store[k] = "none"
    /\ Arrive(s, i, c, pinned)

\* The harness sends a request that failed again: after a router crash, or
\* after every BAA account failed. A crash between judging and storing lost its
\* judgments, so its parts are judged again.
Retry(s, i, pinned) ==
    LET q == request[s][i] IN
    /\ q.phase = "failed"
    /\ Arrive(s, i, [history |-> q.history, new |-> q.new], pinned)

\* The harness gives up on a request that failed. Another instance crash, as
\* far as the router can see: nothing comes back for it.
Abandon(s, i) ==
    /\ request[s][i].phase = "failed"
    /\ request' = [request EXCEPT ![s][i] = Free]
    /\ UNCHANGED <<store, sealedOnce>>

\* The request's judgments reach the verdict store.
Store(s, i) ==
    LET q == request[s][i]
        verdicts == [k \in Keys |->
           IF k \in q.sealed THEN Merge(store[k], "sealed")
           ELSE IF k \in q.cleared THEN Merge(store[k], "cleared")
           ELSE store[k]]
    IN  /\ q.phase = "judged"
        /\ store' = verdicts
        /\ sealedOnce' = sealedOnce \cup {k \in Keys : verdicts[k] = "sealed"}
        /\ request' = [request EXCEPT ![s][i].phase = "stored"]

\* The lane rule decides, and the request goes to its lane's first account.
Dispatch(s, i) ==
    LET q == request[s][i]
        lane == Lane(q, store)
    IN  /\ q.phase = "stored"
        /\ Send(s, i, q, lane, IF lane = "clean" THEN 1 ELSE BaaWalk[1])
    /\ UNCHANGED <<store, sealedOnce>>

\* The account answers 429 or 5xx, or refuses, before the first byte. The
\* request goes to the next account, or fails when the sealed lane has none left.
Failover(s, i) ==
    LET q == request[s][i]
        next == NextAccount(q.lane, q.account)
    IN  /\ q.phase = "sent"
        /\ IF next.lane = "failed"
           THEN request' = [request EXCEPT ![s][i] = Failed(q)]
           ELSE Send(s, i, q, next.lane, next.account)
        /\ UNCHANGED <<store, sealedOnce>>

\* A login folder's 401 before the first byte, while the account has its 401
\* resend: its login is made fit again and the request is sent to the same
\* account once more, from a fresh read of the verdict store, which may move it
\* sealed. A second 401 at the account is a failure, and the request fails over.
Rejected(s, i) ==
    LET q == request[s][i] IN
    /\ q.phase = "sent"
    /\ ~q.spent
    /\ Send(s, i, [q EXCEPT !.spent = TRUE, !.resentHere = TRUE], q.lane, q.account)
    /\ UNCHANGED <<store, sealedOnce>>

\* Rule 7's reasoning refusal before the first byte. The request is sent to the
\* same account again, from a fresh read of the verdict store.
Resend(s, i) ==
    LET q == request[s][i] IN
    /\ q.phase = "sent"
    /\ Send(s, i, q, q.lane, q.account)
    /\ UNCHANGED <<store, sealedOnce>>

\* The first byte of a reply arrives, and nothing fails over after it.
Reply(s, i) ==
    /\ request[s][i].phase = "sent"
    /\ request' = [request EXCEPT ![s][i] = Free]
    /\ UNCHANGED <<store, sealedOnce>>

\* The router dies. Every request inside it fails at the harness, whatever its
\* phase. A request that was "judged" is the crash between judging and
\* storing. The verdict store stays on disk, and the next router reads it.
RouterCrash ==
    /\ \E s \in Sessions, i \in Slots : request[s][i] # Free
    /\ request' = [s \in Sessions |-> [i \in Slots |->
          IF request[s][i] = Free THEN Free ELSE Failed(request[s][i])]]
    /\ UNCHANGED <<store, sealedOnce>>

\* A build with a new policy version starts. It comes with a new router
\* process, so every request inside fails, and every stored verdict retires.
PolicyChange ==
    /\ store' = [k \in Keys |-> "none"]
    /\ sealedOnce' = {}
    /\ request' = [s \in Sessions |-> [i \in Slots |->
          IF request[s][i] = Free THEN Free ELSE Failed(request[s][i])]]

Next ==
    \/ \E s \in Sessions, i \in Slots, pinned \in BOOLEAN :
          \/ \E c \in Contents(s) : Prompt(s, i, c, pinned) \/ Compaction(s, i, c, pinned)
          \/ Retry(s, i, pinned)
    \/ \E s \in Sessions, i \in Slots :
          Store(s, i) \/ Dispatch(s, i) \/ Failover(s, i) \/ Rejected(s, i) \/ Resend(s, i)
          \/ Reply(s, i) \/ Abandon(s, i)
    \/ RouterCrash
    \/ PolicyChange

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* The properties. Each reads what a request carried at an account, as a  *)
(* mock upstream would record it.                                         *)

AtOpenAccount == {q \in {request[s][i] : s \in Sessions, i \in Slots} :
                    q.phase = "sent" /\ q.lane = "clean"}

\* (a) No part reaches an open account unless its content key is cleared or it is the stub.
NoSealedPartAtOpenAccount ==
    \A q \in AtOpenAccount : \A k \in DOMAIN q.body : q.body[k] # "sealed"
NoUnjudgedPartAtOpenAccount ==
    \A q \in AtOpenAccount : \A k \in DOMAIN q.body : q.body[k] # "none"

\* (b) A request with sealed new content never goes to an open account, and
\* failover only moves from the clean lane to the sealed lane.
SealedNewContentRunsSealed == \A q \in AtOpenAccount : ~q.sealedNew
FailoverOnlyToSealedLane == \A q \in AtOpenAccount : ~q.wasSealed

\* (c) A verdict never changes from sealed to cleared inside one policy version.
VerdictNeverUnseals == \A k \in sealedOnce : store[k] = "sealed"

\* (e) A pinned request never reaches an open account, whatever pinned it: the
\* session's pin, phi/sealed, the pinned subagent's line, a BAA repo or Codex's
\* thread-title request.
PinnedRequestRunsSealed == \A q \in AtOpenAccount : ~q.pinned

\* Each account a request is sent to has its own 401 resend, whichever step
\* brought the request there: it is spent only by a resend to that account.
\* resentHere records whether the request's last 401 resend went to the account
\* it is at now, and only this invariant reads it.
ResendPerAccount ==
    \A s \in Sessions, i \in Slots :
        LET q == request[s][i] IN
        q.phase = "sent" => (q.spent <=> q.resentHere)

\* Each send names the substitute exactly when the account it went to is a BAA
\* account that lacks the target model, whichever step brought it there.
SubstitutePerAccount ==
    \A s \in Sessions, i \in Slots :
        LET q == request[s][i] IN
        q.phase = "sent" => (q.substitute <=> (q.lane = "sealed" /\ q.account \in Lacking))

\* A send names the substitute only once the request was sent to every BAA
\* account that carries its target model, so a healthy one never loses the
\* request to one that lacks the model. triedBaa holds the BAA accounts the
\* request was sent to, and only this invariant reads it.
TargetModelFirst ==
    \A s \in Sessions, i \in Slots :
        LET q == request[s][i] IN
        (q.phase = "sent" /\ q.substitute) => ((1..BaaAccounts) \ Lacking) \subseteq q.triedBaa

TypeOK ==
    /\ store \in [Keys -> {"none", "sealed", "cleared"}]
    /\ sealedOnce \subseteq Keys
    /\ \A s \in Sessions, i \in Slots :
          LET q == request[s][i] IN
          \/ q = Free
          \/ /\ q.phase \in {"judged", "stored", "sent", "failed"}
             /\ [history |-> q.history, new |-> q.new] \in Contents(s)
             /\ q.sealed \cup q.cleared \subseteq Parts(q)
             /\ q.lane \in {"none", "clean", "sealed"}

\* Nothing tells one session from another, or one part of a session from another.
Symmetry == {p \in Permutations(Keys) : \A s \in Sessions : {p[k] : k \in s} \in Sessions}

-----------------------------------------------------------------------------
(* Broken variants. Each bends one design step. A configuration under     *)
(* breaks/ swaps one in with `<-` and names the one rule that must fail.  *)

\* The stub step is removed: every part passes as it is.
PassesWithoutStub(k, verdicts) == TRUE

\* The router judges only the new content.
ToJudgeNewContentOnly(c, verdicts) == {k \in c.new : verdicts[k] = "none"}

\* The border stubs sealed parts only, so an unjudged part passes.
PassesUnjudged(k, verdicts) == verdicts[k] # "sealed"

\* The lane rule forgets the stored verdicts: only this request's own judgments count.
LaneFromThisRequestOnly(q, verdicts) ==
    IF q.pinned \/ q.sealed # {} THEN "sealed" ELSE "clean"

\* The walk wraps: past the last BAA account it tries the clean lane again.
NextAccountWraps(lane, account) ==
    IF account < (IF lane = "clean" THEN OpenAccounts ELSE BaaAccounts)
    THEN [lane |-> lane, account |-> account + 1]
    ELSE [lane |-> IF lane = "clean" THEN "sealed" ELSE "clean", account |-> 1]

\* The last write wins: a later cleared judgment replaces a sealed verdict.
MergeLastWriteWins(old, fresh) == fresh

\* A request keeps its 401 resend's state when it moves to another account.
AllowanceCarried(q, to) == q.spent

\* A request keeps the substitute once a send got it, as a flag of the request.
SubstituteCarried(q, to) == q.substitute \/ (to.lane = "sealed" /\ to.account \in Lacking)

\* Only a request's first send can name the substitute, so a request that moves
\* to a BAA account that lacks its target model keeps naming that model there.
SubstituteOnFirstSendOnly(q, to) == q.lane = "none" /\ to.lane = "sealed" /\ to.account \in Lacking

\* The sealed walk keeps the file's order, so a BAA account that lacks the
\* target model comes before one that carries it.
BaaWalkInFileOrder == [n \in 1..BaaAccounts |-> n]

\* The lane rule forgets the pin.
LaneIgnoresPin(q, verdicts) ==
    IF q.sealed # {} \/ \E k \in q.new : verdicts[k] = "sealed" THEN "sealed" ELSE "clean"
=============================================================================
