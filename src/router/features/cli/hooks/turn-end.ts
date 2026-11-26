import { Array, Clock, Console, DateTime, Duration, Effect, Option, Schema, Struct, pipe } from "effect";
import type { Overflow, Reported } from "./phi-text.ts";
import { backOf, openOf, overflowNotice, sealNotice, withheldNotice } from "./phi-text.ts";
import type { Noticed } from "#router/client/turn-notices.ts";
import { SessionId } from "#shared/cli.ts";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { TurnNotices } from "#router/client/turn-notices.ts";
import { failedAs } from "#router/features/cli/sessions/index.ts";
import { portOf } from "./session-start.ts";
import { standardInput } from "#router/client/standard-input.ts";

const HookInput = Schema.fromJsonString(Schema.Struct({ session_id: SessionId }));

const Notice = Schema.fromJsonString(Schema.Struct({ systemMessage: Schema.String }));

const none = 0;

const quietWithoutStamp = Duration.toMillis("30 minutes");

interface Told {
	readonly sealed: number;
	readonly gaveUp: number;
	readonly overflow: Option.Option<Overflow>;
}

const toldAt = (status: Reported, now: number, seen: Noticed): readonly [Told, Noticed] => {
	const open = openOf(status);
	const back = backOf(open);
	const overflowed = status.overflowed ?? none;
	const count = overflowed - (seen.overflowed ?? none);
	const sealed = status.sealed - seen.sealed;

	const gaveUpNow = pipe(
		Option.fromUndefinedOr(status.pinned),
		Option.map((pinned) => pinned.gaveUp),
		Option.getOrElse(() => none),
	);

	const gaveUp = gaveUpNow - (seen.gaveUp ?? none);
	const counts = { gaveUp: gaveUpNow, overflowed, sealed: status.sealed };

	if (count <= none || now < (seen.quietUntil ?? none)) {
		return [{ gaveUp, overflow: Option.none(), sealed }, Struct.assign(counts, Struct.pick(seen, ["quietUntil"]))];
	}

	const counted = { count, subscriptions: open.length };

	const overflow: Overflow = Option.match(back, {
		onNone: () => counted,
		onSome: (at) => Struct.assign(counted, { back: at }),
	});

	const quietUntil = Option.getOrElse(back, () => now + quietWithoutStamp);

	return [{ gaveUp, overflow: Option.some(overflow), sealed }, Struct.assign(counts, { quietUntil })];
};

const toldSince = Effect.fnUntraced(function* toldSince(session: typeof SessionId.Type, port: number) {
	const requests = yield* SessionRequests;
	const notices = yield* TurnNotices;
	const status = yield* Effect.mapError(requests.status(port, session), failedAs({ command: "status", port }));
	const now = yield* Clock.currentTimeMillis;

	const before = yield* Effect.map(
		notices.read(session),
		Option.getOrElse(() => ({ sealed: none })),
	);

	const [told, after] = toldAt(status, now, before);

	yield* notices.write(session, after);

	return { status, told };
});

const turnEnd = Effect.fn("turn-end")(function* turnEnd(hook: { readonly address: string }) {
	const port = portOf(hook.address);

	if (Option.isNone(port)) {
		return;
	}

	const text = yield* standardInput;
	const input = yield* Schema.decodeEffect(HookInput)(text);

	const lines = yield* Effect.gen(function* noticed() {
		const { status, told } = yield* toldSince(input.session_id, port.value);
		const overflow = yield* Effect.transposeOption(pipe(told.overflow, Option.map(overflowNotice)));

		const sealed = pipe(
			Option.liftPredicate(told.sealed, (count) => count > none),
			Option.map((count) => sealNotice({ count, status })),
		);

		const withheld = pipe(
			Option.liftPredicate(told.gaveUp, (count) => count > none),
			Option.map(withheldNotice),
		);

		return Array.getSomes([sealed, withheld, overflow]);
	}).pipe(Effect.catchTag("RouterUnanswered", (failed) => Effect.succeed([failed.message])));

	if (Array.isReadonlyArrayNonEmpty(lines)) {
		const printed = yield* Schema.encodeEffect(Notice)({ systemMessage: Array.join(lines, "\n") });

		yield* Console.log(printed);
	}
}, DateTime.withCurrentZoneLocal);

export { toldSince, turnEnd };
