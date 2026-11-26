import { Console, DateTime, Effect, Option, Schema, String as Str } from "effect";
import { Proofs, SessionRequests } from "#router/client/router-port/index.ts";
import { statusLine, statusText, usage } from "./phi-text.ts";
import type { SessionId } from "#shared/cli.ts";
import { StatuslineJson } from "#shared/cli.ts";
import { failedAs } from "#router/features/cli/sessions/index.ts";
import { portOf } from "./session-start.ts";
import { versionWait } from "#router/features/cli/newer-plugin.ts";

const unprotected = "phi-router: this instance's model address names no router, so phi-router does not route it.";

const statusOf = Effect.fnUntraced(function* statusOf(address: string, session: typeof SessionId.Type) {
	const port = yield* Effect.mapError(Effect.fromOption(portOf(address)), () => unprotected);
	const requests = yield* SessionRequests;
	const proofs = yield* Proofs;

	const status = yield* Effect.mapError(
		requests.status(port, session),
		(failed) => failedAs({ command: "status", port })(failed).message,
	);

	const proven = yield* proofs.ask(port);

	if (proven.kind !== "proved") {
		return { status };
	}

	const wait = yield* versionWait(Option.getOrUndefined(proven.version));

	return { status, wait: Option.getOrUndefined(wait) };
});

const asksUsage = (words: string): boolean => Str.isNonEmpty(Str.trim(words));

const shownOf = Effect.fnUntraced(function* shownOf(words: string, address: string, session: typeof SessionId.Type) {
	if (asksUsage(words)) {
		return { reply: usage };
	}

	const { status, wait } = yield* statusOf(address, session);

	return { line: yield* statusLine(status, wait), reply: yield* statusText(status, wait) };
}, DateTime.withCurrentZoneLocal);

const statusline = Effect.fn("statusline")(function* statusline(
	words: string,
	address: string,
	session: typeof SessionId.Type,
) {
	const shown = yield* shownOf(words, address, session).pipe(
		Effect.catch((error) => Effect.succeed({ reply: error })),
	);

	const printed = yield* Schema.encodeEffect(StatuslineJson)(shown);

	yield* Console.log(printed);
});

export { asksUsage, statusOf, statusline };
