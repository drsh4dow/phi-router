import { Console, Effect, Option, Schema } from "effect";
import { SealNotices } from "#router/client/seal-notices.ts";
import { SessionId } from "#shared/cli.ts";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { failedAs } from "#router/features/cli/sessions/index.ts";
import { portOf } from "./session-start.ts";
import { sealNotice } from "./phi-text.ts";
import { standardInput } from "#router/client/standard-input.ts";

const HookInput = Schema.fromJsonString(Schema.Struct({ session_id: SessionId }));

const Notice = Schema.fromJsonString(Schema.Struct({ systemMessage: Schema.String }));

const noneSealed = 0;

const sealedSince = Effect.fnUntraced(function* sealedSince(session: typeof SessionId.Type, port: number) {
	const requests = yield* SessionRequests;
	const notices = yield* SealNotices;
	const status = yield* Effect.mapError(requests.status(port, session), failedAs({ command: "status", port }));
	const before = yield* notices.swap(session, status.sealed);

	return { count: status.sealed - Option.getOrElse(before, () => noneSealed), status };
});

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

export { sealedSince, turnEnd };
