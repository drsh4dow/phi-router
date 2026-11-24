import { Console, Effect, Option, Schema } from "effect";
import { SealNotices } from "#router/client/seal-notices.ts";
import { SessionId } from "#shared/cli.ts";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { failedAs } from "./pin.ts";
import { portOf } from "./session-start.ts";
import { sealNotice } from "./phi-text.ts";
import { standardInput } from "#router/client/standard-input.ts";

/** What a turn-end hook reads on its stdin. The harness's field name stays here. */
const HookInput = Schema.fromJsonString(Schema.Struct({ session_id: SessionId }));

/** A notice both harnesses show the developer and never send the model. */
const Notice = Schema.fromJsonString(Schema.Struct({ systemMessage: Schema.String }));

const noneSealed = 0;

/** How many messages the session sealed since its last turn end, by the router on `port`, and its status. */
const sealedSince = Effect.fnUntraced(function* sealedSince(session: typeof SessionId.Type, port: number) {
	const requests = yield* SessionRequests;
	const notices = yield* SealNotices;
	const status = yield* Effect.mapError(requests.status(port, session), failedAs({ command: "status", port }));
	const before = yield* notices.swap(session, status.sealed);

	return { count: status.sealed - Option.getOrElse(before, () => noneSealed), status };
});

/**
 * The turn-end hook's command. When `address` names a router, it asks the router for the session's sealed count and,
 * when the count grew since the session's last turn end, prints a notice that names how many messages the turn sealed.
 * A session it never saw counts from none. When no router answers, the notice is `RouterUnanswered`'s line. It prints
 * nothing otherwise.
 */
const turnEnd = Effect.fn("turn-end")(function* turnEnd(hook: { readonly address: string }) {
	const port = portOf(hook.address);

	if (Option.isNone(port)) {
		return;
	}

	const text = yield* standardInput;
	const input = yield* Schema.decodeEffect(HookInput)(text);

	const notice = yield* sealedSince(input.session_id, port.value).pipe(
		Effect.map((sealed) =>
			Option.liftPredicate(sealed, ({ count }) => count > noneSealed).pipe(Option.map(sealNotice)),
		),
		Effect.catchTag("RouterUnanswered", (failed) => Effect.succeedSome(failed.message)),
	);

	if (Option.isSome(notice)) {
		const printed = yield* Schema.encodeEffect(Notice)({ systemMessage: notice.value });

		yield* Console.log(printed);
	}
});

export { turnEnd };
