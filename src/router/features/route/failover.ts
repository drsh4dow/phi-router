import type { Aim, Arrived } from "./send.ts";
import { Array, Effect, Option, Predicate, Ref, Schema, Stream, Struct, pipe } from "effect";
import type { PlatformError, Scope } from "effect";
import type { Spend, Stop } from "./walked.ts";
import { chosen, keepingReplyKeys, targetOf } from "./send.ts";
import { current, onward, walkOf } from "#router/features/accounts/index.ts";
import { lineOf, stopped, unwalked } from "./walked.ts";
import type { Account } from "#router/client/accounts/index.ts";
import type { Digest } from "effect/crypto";
import type { Outgoing } from "#router/client/router-port/index.ts";
import type { Walk } from "#router/features/accounts/index.ts";
import { reasoningRejected } from "#router/features/codex/index.ts";
import { stopLines } from "./stopped.ts";

const statuses = { failed: 500, ok: 200, rateLimited: 429, unauthorized: 401, unreadable: 400 } as const;

class BaaKeyRefused extends Schema.TaggedError<BaaKeyRefused, { readonly brand: unique symbol }>()("BaaKeyRefused", {
	account: Schema.String,
	harness: Schema.Literals(["claude", "codex", "pi"]),
}) {
	public override get message(): string {
		return stopLines.baaKeyRefused(this.harness);
	}
}

const relaying = { kind: "relayed" } as const;

type Unanswered = Effect.Error<ReturnType<Account["send"]>>;

type Unrouted = BaaKeyRefused | PlatformError.PlatformError | Schema.SchemaError | Unanswered;

type Relaying = Digest.Digest | Scope.Scope;

type Sent =
	| { readonly kind: "answered"; readonly outgoing: Outgoing }
	| { readonly kind: "unreadable"; readonly outgoing: Outgoing; readonly text: string }
	| { readonly kind: "failed" | "rejected"; readonly last: Effect.Effect<Outgoing, Unanswered> };

interface Walking extends Arrived {
	readonly stopping: (aim: Aim, spend: Spend) => Effect.Effect<Stop>;
}

const sentTo = Effect.fnUntraced(function* sentTo(arrival: Walking, aim: Aim) {
	const { incoming, request, serving, session } = arrival;
	const { account, lane } = current(aim.walk);

	return yield* account.send({ body: aim.send.body, headers: incoming.headers }).pipe(
		Effect.filterOrFail(
			(answer) => lane === "clean" || answer.status !== statuses.unauthorized,
			() => BaaKeyRefused.make({ account: account.name, harness: serving.wire.harness }),
		),
		Effect.flatMap((answer): Effect.Effect<Sent, Unrouted, Digest.Digest> => {
			if (answer.status === statuses.rateLimited || answer.status >= statuses.failed) {
				const stamps = Effect.succeed(lane === "clean" && answer.status === statuses.rateLimited);
				const sent: Sent = { kind: "failed", last: Effect.succeed(Struct.assign(answer, relaying)) };

				return Effect.as(Effect.when(serving.accountState.stamp(account.name), stamps), sent);
			}

			if (answer.status === statuses.unreadable && Predicate.isNotUndefined(request.withoutReasoning)) {
				return Effect.map(Stream.runCollect(answer.body), (chunks) => ({
					kind: "unreadable",
					outgoing: Struct.assign(answer, { body: Stream.fromIterable(chunks), kind: "relayed" as const }),
					text: new TextDecoder().decode(Buffer.concat(chunks)),
				}));
			}

			if (answer.status !== statuses.ok || lane === "sealed") {
				return Effect.succeed({ kind: "answered", outgoing: Struct.assign(answer, relaying) });
			}

			return Effect.map(keepingReplyKeys({ serving, session }), (keeping) => ({
				kind: "answered",
				outgoing: Struct.assign(answer, { body: keeping(answer.body), kind: "relayed" as const }),
			}));
		}),
		Effect.catchTags({
			LoginEnded: (ended) =>
				Effect.logWarning(ended.message).pipe(Effect.as<Sent>({ kind: "failed", last: Effect.fail(ended) })),
			Rejected: (rejected) => Effect.succeed<Sent>({ kind: "rejected", last: Effect.fail(rejected) }),
			UpstreamRefused: (refused) => Effect.succeed<Sent>({ kind: "failed", last: Effect.fail(refused) }),
		}),
	);
});

const readied = (walk: Walk): Effect.Effect<Option.Option<Walk>, Unrouted> =>
	Effect.matchEffect(current(walk).account.ready(), {
		onFailure: (failure) =>
			Effect.andThen(
				Effect.logWarning(failure.message),
				Option.match(onward(walk), { onNone: () => Effect.fail(failure), onSome: Effect.succeedSome }),
			),
		onSuccess: () => Effect.succeedNone,
	});

const aimed: (arrival: Walking, walk: Walk) => Effect.Effect<Aim, Unrouted, Digest.Digest> = Effect.fnUntraced(
	function* aiming(arrival, walk) {
		const aim = yield* chosen(arrival, walk);

		if (current(aim.walk).account !== current(walk).account) {
			return yield* aimed(arrival, aim.walk);
		}

		const stop = yield* arrival.stopping(aim, "stay");

		if (stop.fit) {
			return aim;
		}

		const unfit = yield* readied(walk);

		return yield* Option.match(unfit, {
			onNone: () => Effect.andThen(arrival.stopping(aim, "fit"), aimed(arrival, walk)),
			onSome: (next) => aimed(arrival, next),
		});
	},
);

const resendOf = Effect.fnUntraced(function* resendOf(arrival: Walking, aim: Aim, text: string) {
	const { withoutReasoning } = arrival.request;

	if (Predicate.isUndefined(withoutReasoning) || !reasoningRejected(text)) {
		return Option.none();
	}

	const request = Struct.assign(Struct.omit(arrival.request, ["withoutReasoning"]), { encode: withoutReasoning });
	const again: Walking = Struct.assign(arrival, { request });
	const next = yield* aimed(again, aim.walk);

	return Option.liftPredicate(
		{ aim: next, arrival: again },
		() => next.send.body !== aim.send.body || current(next.walk).account !== current(aim.walk).account,
	);
});

const nextAfter = (arrival: Walking, aim: Aim, rejected: boolean): Effect.Effect<Option.Option<Walk>> => {
	if (!rejected) {
		return Effect.succeed(onward(aim.walk));
	}

	return Effect.map(arrival.stopping(aim, "resend"), ({ resent }) => {
		if (resent) {
			return onward(aim.walk);
		}

		return Option.some(aim.walk);
	});
};

const tried: (arrival: Walking, aim: Aim) => Effect.Effect<Outgoing, Unrouted, Relaying> = Effect.fnUntraced(
	function* attempt(arrival, aim) {
		const sent = yield* sentTo(arrival, aim);

		if (sent.kind === "answered") {
			return sent.outgoing;
		}

		if (sent.kind === "unreadable") {
			const resend = yield* resendOf(arrival, aim, sent.text);

			return yield* Option.match(resend, {
				onNone: () => Effect.succeed(sent.outgoing),
				onSome: (again) => tried(again.arrival, again.aim),
			});
		}

		const next = yield* nextAfter(arrival, aim, sent.kind === "rejected");

		return yield* Option.match(next, {
			onNone: () => sent.last,
			onSome: (walk) => Effect.flatMap(aimed(arrival, walk), (again) => tried(arrival, again)),
		});
	},
);

const dispatched = Effect.fnUntraced(function* dispatched(arrival: Arrived) {
	const { accounts, accountState, laneLog } = arrival.serving;
	const append = yield* laneLog.opened(arrival.session);

	const names = pipe(
		accounts.clean,
		Array.map((account) => account.name),
	);

	const stamps = yield* accountState.stamps(names);
	const stamped = Array.fromIterable(stamps.keys());
	const walk = walkOf({ accounts, model: targetOf(arrival), session: arrival.session, stamped });
	const walked = yield* Ref.make(unwalked({ arrival, walk }));

	const stopping = (aim: Aim, spend: Spend): Effect.Effect<Stop> =>
		Ref.modify(walked, (now) => {
			const { afterSpend, beforeSpend } = stopped({ aim, spend, walked: now });

			return [beforeSpend, afterSpend];
		});

	const walking: Walking = Struct.assign(arrival, { stopping });

	return yield* aimed(walking, walk).pipe(
		Effect.flatMap((aim) => tried(walking, aim)),
		Effect.onExit(() => Effect.flatMap(Ref.get(walked), (done) => append(lineOf({ arrival, walked: done })))),
	);
});

export { dispatched };
