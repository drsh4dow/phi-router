import { Effect, Layer, Option, Ref } from "effect";
import { LeaseRequests, Proofs } from "#router/client/router-port/index.ts";
import { Platform, start } from "#router/features/cli/index.ts";
import { NodeServices } from "@effect/platform-node";
import { Processes } from "#router/client/processes.ts";
import { TestClock } from "effect/testing";
import { it } from "@effect/vitest";

const instance = { folder: "/project", pid: 4242, session: "session" };

const port = 47_411;

const lostTheBind = 1;

const silent = { kind: "unanswered" } as const;

const proved = { kind: "proved", version: Option.none() } as const;

const wonByAnother = Layer.effect(
	Proofs,
	Effect.gen(function* wonByAnother() {
		const answers = yield* Ref.make<readonly (typeof proved | typeof silent)[]>([silent]);

		return Proofs.of({
			ask: () => Ref.modify(answers, ([first = proved, ...rest]) => [first, rest]),
			callerHeaders: () => Effect.die("unused"),
			row: () => Effect.die("unused"),
		});
	}),
);

const leases = Layer.succeed(LeaseRequests, LeaseRequests.of({ post: () => Effect.succeed("accepted") }));

const launchedLoser = Layer.succeed(
	Processes,
	Processes.of({
		launched: () => Effect.succeed({ exited: Effect.succeedSome(lostTheBind) }),
		running: () => Effect.die("unused"),
	}),
);

const platform = Layer.succeed(Platform, { entry: "/nowhere/phi-router.mjs", name: "bun", os: "linux" });

it.layer(Layer.mergeAll(wonByAnother, leases, launchedLoser, platform, NodeServices.layer))(
	"a start racing another start with no router up",
	(test) => {
		test.effect(
			"leases the router that won, though its own router lost the bind and its first proof found the port silent",
			() => start(instance, port, "claude").pipe(TestClock.withLive),
		);
	},
);
