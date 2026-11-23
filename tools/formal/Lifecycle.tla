----------------------------- MODULE Lifecycle -----------------------------
(***************************************************************************)
(* When the router runs: it starts with the first harness instance and     *)
(* exits after the last one ended. Property (d).                         *)
(*                                                                         *)
(* An instance is one harness process. Its lease is its pid plus that      *)
(* process's start time, so a process that later gets the same pid is not  *)
(* the instance. The Codex TUI leases its background process, which is    *)
(* just another instance here.                                             *)
(*                                                                         *)
(* Time passes in ticks of one lease interval, 5 seconds. A running router *)
(* checks its leases once in each interval, and a closing router's process *)
(* ends before the next one. Fairness makes the router take those steps.   *)
(*                                                                         *)
(* Each action is one step the code takes without an await inside it.     *)
(* .agents/skills/verify-formal-model/SKILL.md names the code behind each. *)
(***************************************************************************)
EXTENDS Naturals, TLC

CONSTANT Instances  \* the harness processes that may ever start

VARIABLES
    instance,  \* instance[i]: "absent", "starting" (its session-start hook runs `phi-router start`),
               \* "registered" (start returned with the lease accepted), "ended", or "reused"
               \* (ended, and another process now has its pid)
    leases,    \* the lease registry, stored state
    router,    \* the router process: "down", "up", or "closing" (it stopped accepting and has not exited)
    checked,   \* the router ran its lease check in this interval
    idle,      \* intervals begun with the router running and no registered instance alive, up to 2
    exited     \* the router's last stop was its own exit, not a crash

vars == <<instance, leases, router, checked, idle, exited>>

Alive(i) == instance[i] \in {"starting", "registered"}
Registered == {i \in Instances : instance[i] = "registered"}

-----------------------------------------------------------------------------
(* The design's steps, one operator each. A configuration under breaks/   *)
(* swaps one for a broken variant at the end of this module.              *)

\* The router takes a lease only while it is up. It stops accepting in the
\* same step that decides to exit.
Accepting(state) == state = "up"

\* A launched router starts from the stored lease registry.
Adopted(registry) == registry

\* A lease holds while its pid exists, is no zombie, and has the lease's start time.
LeaseHolds(i) == Alive(i)

\* The closing router's process ends.
Exit(state) == "down"

-----------------------------------------------------------------------------
Init ==
    /\ instance = [i \in Instances |-> "absent"]
    /\ leases = {}
    /\ router = "down"
    /\ checked = FALSE
    /\ idle = 0
    /\ exited = FALSE

\* A harness process starts, and its session-start hook runs `phi-router start`.
\* The harness holds its first prompt until the hook returns.
InstanceStart(i) ==
    /\ instance[i] = "absent"
    /\ instance' = [instance EXCEPT ![i] = "starting"]
    /\ UNCHANGED <<leases, router, checked, idle, exited>>

\* `start` met a refused connection and launched `serve`, which bound the port.
\* A closing router still holds the port, so a new one binds only once it is
\* down. Every session-start source runs `start`, so a registered instance
\* launches a router too after a crash.
Launch(i) ==
    /\ Alive(i)
    /\ router = "down"
    /\ router' = "up"
    /\ leases' = Adopted(leases)
    /\ checked' = TRUE
    /\ idle' = 0
    /\ exited' = FALSE
    /\ UNCHANGED instance

\* The router accepts and stores the lease, and only then `start` returns.
\* Registering twice changes nothing.
Register(i) ==
    /\ Alive(i)
    /\ Accepting(router)
    /\ leases' = leases \cup {i}
    /\ instance' = [instance EXCEPT ![i] = "registered"]
    /\ idle' = 0
    /\ UNCHANGED <<router, checked, exited>>

\* The harness process exits, or is killed with kill -9. Nothing tells the router.
InstanceEnds(i) ==
    /\ Alive(i)
    /\ instance' = [instance EXCEPT ![i] = "ended"]
    /\ UNCHANGED <<leases, router, checked, idle, exited>>

\* Another process gets the ended instance's pid.
PidReused(i) ==
    /\ instance[i] = "ended"
    /\ instance' = [instance EXCEPT ![i] = "reused"]
    /\ UNCHANGED <<leases, router, checked, idle, exited>>

\* The lease check, once in each interval. It drops every lease that no longer
\* holds, and when none is left it stops accepting, in the same step.
LeaseCheck ==
    LET held == {i \in leases : LeaseHolds(i)} IN
    /\ router = "up"
    /\ ~checked
    /\ leases' = held
    /\ router' = IF held = {} THEN "closing" ELSE "up"
    /\ checked' = TRUE
    /\ UNCHANGED <<instance, idle, exited>>

\* The closing router's process ends and frees the port.
RouterExit ==
    /\ router = "closing"
    /\ router' = Exit(router)
    /\ exited' = (router' = "down")
    /\ UNCHANGED <<instance, leases, checked, idle>>

\* The router process dies. The stored lease registry stays.
RouterCrash ==
    /\ router # "down"
    /\ router' = "down"
    /\ exited' = FALSE
    /\ UNCHANGED <<instance, leases, checked, idle>>

\* One lease interval passes. A running router has checked once in it, and a
\* closing one has exited.
Tick ==
    /\ router = "up" => checked
    /\ router # "closing"
    /\ checked' = FALSE
    /\ idle' = IF router = "up" /\ Registered = {} THEN IF idle < 2 THEN idle + 1 ELSE 2 ELSE 0
    /\ UNCHANGED <<instance, leases, router, exited>>

Next ==
    \/ \E i \in Instances :
          InstanceStart(i) \/ Launch(i) \/ Register(i) \/ InstanceEnds(i) \/ PidReused(i)
    \/ LeaseCheck
    \/ RouterExit
    \/ RouterCrash
    \/ Tick

\* The router's own steps are never put off forever: its lease check, its exit,
\* and the passing of time. A harness instance gets no fairness: it may run
\* forever, and it may never start.
Fairness == WF_vars(LeaseCheck) /\ WF_vars(RouterExit) /\ WF_vars(Tick)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* (d) The router never exits while a registered instance is alive, and    *)
(* exits within the lease interval after the last one ended.               *)

\* A router that exited on its own has no registered instance alive.
NeverExitsWhileRegistered == exited => Registered = {}

\* With no registered instance alive, the router is gone before a second
\* interval begins: within 10 seconds.
ExitsWithinLeaseInterval == router # "down" => idle < 2

\* Once no instance is alive, the router is eventually down, unless a new
\* instance starts first.
NoneAlive == \A i \in Instances : ~Alive(i)
ExitsAfterLastInstance == NoneAlive ~> (router = "down" \/ ~NoneAlive)

TypeOK ==
    /\ instance \in [Instances -> {"absent", "starting", "registered", "ended", "reused"}]
    /\ leases \subseteq Instances
    /\ router \in {"down", "up", "closing"}
    /\ checked \in BOOLEAN
    /\ idle \in 0..2
    /\ exited \in BOOLEAN

-----------------------------------------------------------------------------
(* Broken variants. Each bends one design step. A configuration under     *)
(* breaks/ swaps one in with `<-` and names the one rule that must fail.   *)

\* The router still takes leases after it decided to exit.
AcceptingWhileClosing(state) == state \in {"up", "closing"}

\* The lease registry lives in memory only: a launched router starts with none.
AdoptedNothing(registry) == {}

\* A lease is a pid alone, so a reused pid keeps it.
LeaseHoldsByPidOnly(i) == instance[i] \in {"starting", "registered", "reused"}

\* The router decides to exit, and its process never ends.
ExitNever(state) == state
=============================================================================
