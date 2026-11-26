import { Console, DateTime, Effect, Schema, String as Str } from "effect";
import { statusLine, statusText, usage } from "./phi-text.ts";
import type { SessionId } from "#shared/cli.ts";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { failedAs } from "#router/features/cli/sessions/index.ts";
import { portOf } from "./session-start.ts";

const Shown = Schema.fromJsonString(Schema.Struct({ line: Schema.optionalKey(Schema.String), reply: Schema.String }));

const unprotected = "phi-router: this instance's model address names no router, so phi-router does not route it.";

const statusOf = Effect.fnUntraced(function* statusOf(address: string, session: typeof SessionId.Type) {
	const port = yield* Effect.mapError(Effect.fromOption(portOf(address)), () => unprotected);
	const requests = yield* SessionRequests;

	return yield* Effect.mapError(
		requests.status(port, session),
		(failed) => failedAs({ command: "status", port })(failed).message,
	);
});

const asksUsage = (words: string): boolean => Str.isNonEmpty(Str.trim(words));

const shownOf = Effect.fnUntraced(function* shownOf(words: string, address: string, session: typeof SessionId.Type) {
	if (asksUsage(words)) {
		return { reply: usage };
	}

	const status = yield* statusOf(address, session);

	return { line: statusLine(status), reply: yield* statusText(status) };
}, DateTime.withCurrentZoneLocal);

const statusline = Effect.fn("statusline")(function* statusline(
	words: string,
	address: string,
	session: typeof SessionId.Type,
) {
	const shown = yield* shownOf(words, address, session).pipe(
		Effect.catch((error) => Effect.succeed({ reply: error })),
	);

	const printed = yield* Schema.encodeEffect(Shown)(shown);

	yield* Console.log(printed);
});

export { asksUsage, statusOf, statusline };
