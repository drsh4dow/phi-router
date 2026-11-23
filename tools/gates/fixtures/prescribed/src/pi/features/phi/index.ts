import { Effect } from "effect";
import { Router } from "#pi/client/router.ts";
import type { SessionId } from "#shared/cli.ts";

/** Asks the router on `port` for one session's status. */
const phi = Effect.fn("phi")(function* phi(session: typeof SessionId.Type, port: number) {
	const router = yield* Router;

	return yield* router.status(session, port);
});

export { phi };
