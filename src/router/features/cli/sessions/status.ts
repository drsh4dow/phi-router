import { Console, Effect, Schema } from "effect";
import type { SessionId } from "#shared/cli.ts";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { StatusJson } from "#shared/cli.ts";
import { failedAs } from "./pin.ts";

const status = Effect.fn("status")(function* status(session: typeof SessionId.Type, port: number) {
	const requests = yield* SessionRequests;
	const reported = yield* Effect.mapError(requests.status(port, session), failedAs({ command: "status", port }));
	const line = yield* Effect.orDie(Schema.encodeEffect(StatusJson)(reported));

	yield* Console.log(line);
});

export { status };
