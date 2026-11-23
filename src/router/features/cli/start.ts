import type { Answered, LeaseRequest } from "#router/client/lease-request.ts";
import { Effect, Schedule, Schema } from "effect";
import { LeaseRequests } from "#router/client/lease-request.ts";
import { Pid } from "#shared/cli.ts";
import { Platform } from "./platform.ts";
import { Processes } from "#router/client/processes.ts";
import { Proofs } from "#router/client/proof.ts";

/** How long `start` waits for a router to take the lease. */
const patience = "10 seconds";

const pause = "50 millis";

const notRunning = "the process is not running";

const noRouter = "no router took the lease within 10 s";

const notYours = "the port does not hold your router";

/** What each reason asks of the person who reads it. */
const next = {
	[noRouter]: "phi-router serve with the same --port prints why a router does not start.",
	[notRunning]: "Pass the pid of the harness process.",
	[notYours]: "Another user's program may listen there, or your router's secret is gone. Nothing more was sent to it.",
} as const;

/** `start` could not leave a lease with a router. */
class StartFailed extends Schema.TaggedError<StartFailed, { readonly brand: unique symbol }>()("StartFailed", {
	pid: Pid,
	port: Schema.Int,
	reason: Schema.Literals([notRunning, noRouter, notYours]),
}) {
	public override get message(): string {
		return `phi-router start --pid ${String(this.pid)} --port ${String(this.port)}: ${this.reason}. ${next[this.reason]}`;
	}
}

const settled = (answered: Answered): boolean => answered === "accepted" || answered === "ended";

/**
 * Leaves a lease for the request's pid with the router on `port`, launching the router when nothing answers there. It
 * first makes the listener prove it is this user's router (ADR 0002), and fails at once, having sent it nothing else,
 * when it cannot. It returns only once the router stored the lease, and prints nothing, since a session-start hook's
 * output can reach the model. It launches one router at most, and asks a router that is starting up or closing again
 * every 50 ms, for 10 s in all.
 */
const start = Effect.fn("start")(function* start(request: typeof LeaseRequest.Type, port: number) {
	const platform = yield* Platform;
	const requests = yield* LeaseRequests;
	const processes = yield* Processes;
	const proofs = yield* Proofs;
	const failed = (reason: StartFailed["reason"]): StartFailed => StartFailed.make({ pid: request.pid, port, reason });

	const launch = yield* Effect.cached(
		processes.launched([platform.name, platform.entry, "serve", "--port", String(port)]),
	);

	const posted = Effect.gen(function* posted() {
		const proven = yield* proofs.ask(port);

		if (proven === "refuted") {
			return yield* failed(notYours);
		}

		if (proven === "proved") {
			return yield* requests.post(port, request);
		}

		return proven;
	});

	const asked = Effect.tap(posted, (answered) => Effect.when(launch, Effect.succeed(answered === "unanswered")));

	const answered = yield* asked.pipe(
		Effect.repeat({ schedule: Schedule.spaced(pause), until: settled }),
		Effect.timeoutOrElse({
			duration: patience,
			orElse: () => Effect.fail(failed(noRouter)),
		}),
	);

	yield* Effect.when(Effect.fail(failed(notRunning)), Effect.succeed(answered === "ended"));
});

export { start };
