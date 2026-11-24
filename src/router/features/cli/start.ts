import type { Answered, LeaseRequest } from "#router/client/router-port/index.ts";
import { Effect, Option, Schedule, Schema } from "effect";
import { LeaseRequests, Proofs } from "#router/client/router-port/index.ts";
import type { Harness } from "#router/features/border/index.ts";
import { Pid } from "#shared/cli.ts";
import { Platform } from "./platform.ts";
import { Processes } from "#router/client/processes.ts";
import { noBaaKeyExit } from "./no-baa-key.ts";
import { stopLines } from "#router/features/route/index.ts";

const leaseTakenWithin = "10 seconds";

const pause = "50 millis";

const Reason = Schema.Literals(["noBaaKey", "notRunning", "notStarted", "notYours"]);

interface Failing {
	readonly harness: Harness;
	readonly pid: number;
	readonly port: number;
}

/** What each reason tells the person who reads it, which a hook passes on as its block reason. */
const said: Readonly<Record<typeof Reason.Type, (failing: Failing) => string>> = {
	noBaaKey: ({ harness }) => stopLines.noBaaKey(harness),
	notRunning: ({ pid, port }) =>
		`phi-router start --pid ${String(pid)} --port ${String(port)}: the process is not running. Pass the pid of the harness process.`,
	notStarted: ({ harness }) => stopLines.notStarted(harness),
	notYours: ({ pid, port }) =>
		`phi-router start --pid ${String(pid)} --port ${String(port)}: the port does not hold your router. Another user's program may listen there, or your router's secret is gone. Nothing more was sent to it.`,
};

class StartFailed extends Schema.TaggedError<StartFailed, { readonly brand: unique symbol }>()("StartFailed", {
	harness: Schema.Literals(["claude", "codex", "pi"]),
	pid: Pid,
	port: Schema.Int,
	reason: Reason,
}) {
	public override get message(): string {
		return said[this.reason](this);
	}
}

const settled = (answered: Answered): boolean => answered === "accepted" || answered === "ended";

/**
 * Leaves a lease for the request's pid with the router on `port`, launching the router when nothing answers there. It
 * first makes the listener prove it is this user's router (ADR 0002), and fails at once, having sent it nothing else,
 * when it cannot. It returns only once the router stored the lease, and prints nothing, since a session-start hook's
 * output can reach the model. It launches one router at most, and asks a router that is starting up or closing again
 * every 50 ms, for 10 s in all. A router it launched that exits for want of a BAA key fails it at once with the line
 * `harness` shows for that. Any other router that never takes the lease fails it with the line for a router that could
 * not start.
 */
const start = Effect.fn("start")(function* start(request: typeof LeaseRequest.Type, port: number, harness: Harness) {
	const platform = yield* Platform;
	const requests = yield* LeaseRequests;
	const processes = yield* Processes;
	const proofs = yield* Proofs;

	const failed = (reason: typeof Reason.Type): StartFailed =>
		StartFailed.make({ harness, pid: request.pid, port, reason });

	const launch = yield* Effect.cached(
		processes
			.launched([platform.name, platform.entry, "serve", "--port", String(port)])
			.pipe(Effect.mapError(() => failed("notStarted"))),
	);

	const unanswered = launch.pipe(
		Effect.flatMap(({ exited }) => exited),
		Effect.filterOrFail(
			(exited) => !Option.contains(exited, noBaaKeyExit),
			() => failed("noBaaKey"),
		),
	);

	const posted = Effect.gen(function* posted() {
		const proven = yield* proofs.ask(port);

		if (proven === "refuted") {
			return yield* failed("notYours");
		}

		if (proven === "proved") {
			return yield* requests.post(port, request);
		}

		return proven;
	});

	const answered = yield* posted.pipe(
		Effect.tap((asked) => Effect.when(unanswered, Effect.succeed(asked === "unanswered"))),
		Effect.repeat({ schedule: Schedule.spaced(pause), until: settled }),
		Effect.timeoutOrElse({
			duration: leaseTakenWithin,
			orElse: () => Effect.fail(failed("notStarted")),
		}),
	);

	yield* Effect.when(Effect.fail(failed("notRunning")), Effect.succeed(answered === "ended"));
}, Effect.scoped);

export { start };
