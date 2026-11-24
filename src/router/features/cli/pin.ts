import { Effect, Schema } from "effect";
import type { SessionId } from "#shared/cli.ts";
import { SessionRequests } from "#router/client/router-port/index.ts";
import type { Unanswered } from "#router/client/router-port/index.ts";

/** A command that asks the router for a session got no usable answer. */
class RouterUnanswered extends Schema.TaggedError<RouterUnanswered, { readonly brand: unique symbol }>()(
	"RouterUnanswered",
	{ command: Schema.String, port: Schema.Int, reason: Schema.String },
) {
	public override get message(): string {
		return `phi-router ${this.command} --port ${String(this.port)}: ${this.reason}. A protected session starts the router.`;
	}
}

/**
 * The failure of a command asked of the router on a port.
 *
 * @param {object} asked The command's name and the port.
 * @returns {Function} The failure.
 */
const failedAs =
	(asked: { readonly command: string; readonly port: number }) =>
	({ reason }: Unanswered): RouterUnanswered =>
		RouterUnanswered.make({ command: asked.command, port: asked.port, reason });

/**
 * Sets the session's pin on the router on `port` and returns once the router stored it. It prints nothing. It fails
 * when no router answers, since only the router writes the verdict store.
 */
const pin = Effect.fn("pin")(function* pin(session: typeof SessionId.Type, port: number) {
	const requests = yield* SessionRequests;

	yield* Effect.mapError(requests.pin(port, { pinned: true, session }), failedAs({ command: "pin", port }));
});

/** Clears the session's pin, as `pin` sets it. */
const unpin = Effect.fn("unpin")(function* unpin(session: typeof SessionId.Type, port: number) {
	const requests = yield* SessionRequests;

	yield* Effect.mapError(requests.pin(port, { pinned: false, session }), failedAs({ command: "unpin", port }));
});

export { failedAs, pin, unpin };
