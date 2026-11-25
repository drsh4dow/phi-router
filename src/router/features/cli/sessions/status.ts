import { Console, Effect, Schema } from "effect";
import type { SessionId } from "#shared/cli.ts";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { StatusJson } from "#shared/cli.ts";
import type { Unanswered } from "#router/client/router-port/index.ts";

class RouterUnanswered extends Schema.TaggedError<RouterUnanswered, { readonly brand: unique symbol }>()(
	"RouterUnanswered",
	{ command: Schema.String, port: Schema.Int, reason: Schema.String },
) {
	public override get message(): string {
		return `phi-router ${this.command} --port ${String(this.port)}: ${this.reason}. A protected session starts the router.`;
	}
}

const failedAs =
	(asked: { readonly command: string; readonly port: number }) =>
	({ reason }: Unanswered): RouterUnanswered =>
		RouterUnanswered.make({ command: asked.command, port: asked.port, reason });

const status = Effect.fn("status")(function* status(session: typeof SessionId.Type, port: number) {
	const requests = yield* SessionRequests;
	const reported = yield* Effect.mapError(requests.status(port, session), failedAs({ command: "status", port }));
	const line = yield* Effect.orDie(Schema.encodeEffect(StatusJson)(reported));

	yield* Console.log(line);
});

export { failedAs, status };
