import type { Aim, Arrived } from "./send.ts";
import { Array, Effect, Option, Predicate, Ref, Stream, Struct, pipe } from "effect";
import type { PlatformError, Schema, Scope } from "effect";
import type { Spend, Stop } from "./walked.ts";
import { chosen, keepingReplyKeys, targetOf } from "./send.ts";
import { current, onward, walkOf } from "#router/features/accounts/index.ts";
import { lineOf, stopped, unwalked } from "./walked.ts";
import type { Account } from "#router/client/upstream-accounts.ts";
import type { Digest } from "effect/crypto";
import type { Outgoing } from "#router/client/server.ts";
import type { Walk } from "#router/features/accounts/index.ts";
import { reasoningRejected } from "#router/features/codex/index.ts";

const statuses = { failed: 500, ok: 200, rateLimited: 429, unreadable: 400 } as const;

const relaying = { kind: "relayed" } as const;

type Unanswered = Effect.Error<ReturnType<Account["send"]>>;

/** What routing a judged request can fail with. `answering` turns each into an answer. */
type Unrouted = PlatformError.PlatformError | Schema.SchemaError | Unanswered;

type Relaying = Digest.Digest | Scope.Scope;

/**
 * How one send came out, known before any byte reaches the harness. `answered` is relayed. `unreadable` is a 400 read
 * whole, which the reasoning resend may send again. `failed` moves to the next account, `rejected` is a login folder's 401, and the
 * `last` of either is what the harness gets when no account is left. A body left unread closes with the request.
 */
type Sent =
	| { readonly kind: "answered"; readonly outgoing: Outgoing }
	| { readonly kind: "unreadable"; readonly outgoing: Outgoing; readonly text: string }
	| { readonly kind: "failed" | "rejected"; readonly last: Effect.Effect<Outgoing, Unanswered> };

/**
 * A request on its walk: what it arrived as, and how the walk keeps the stop of the account an aim stays at, which
 * answers that account's stop before it spent.
 */
interface Walking extends Arrived {
	readonly stopping: (aim: Aim, spend: Spend) => Effect.Effect<Stop>;
}

/**
 * The send to the walk's current account, kept as the request's latest. A 429 or a 5xx fails over, and a 429 stamps an
 * open account. No answer and an ended login fail over too, the second with its notice logged. An open account's 200
 * keeps its reply keys as it passes.
 */
const sentTo = Effect.fnUntraced(function* sentTo(arrival: Walking, aim: Aim) {
	const { incoming, request, serving, session } = arrival;
	const { account, lane } = current(aim.walk);

	return yield* account.send({ body: aim.send.body, headers: incoming.headers }).pipe(
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

/**
 * Makes the walk's current account fit to send. An ended login fails over with its notice logged.
 *
 * @param {Walk} walk The walk, at the account to make fit.
 * @returns {Effect.Effect} None once the account is fit, the walk past it when its login could not be made fit, or
 *   that failure past the last account.
 */
const readied = (walk: Walk): Effect.Effect<Option.Option<Walk>, Unrouted> =>
	Effect.matchEffect(current(walk).account.ready(), {
		onFailure: (failure) =>
			Effect.andThen(
				Effect.logWarning(failure.message),
				Option.match(onward(walk), { onNone: () => Effect.fail(failure), onSome: Effect.succeedSome }),
			),
		onSuccess: () => Effect.succeedNone,
	});

/**
 * The next send down `walk`. `chosen` reads the store first, so a send that goes sealed moves past an open account
 * without making its login fit. The walk stops at the account it stays at, makes it fit once, and `chosen` reads the
 * store once more for the body, so no vendor CLI runs between that read and the send.
 */
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

/**
 * The reasoning resend: after a 400 that says the account could not read an encrypted reasoning item, the request once more
 * with no reasoning. None when the 400 says something else, or when dropping the reasoning leaves the body as it was for
 * the same account, as it always does on the sealed lane. Dropping the reasoning is the request's, so it happens once.
 */
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

/**
 * Route.tla `Rejected` and `Failover`: where the walk goes after an account failed before the first byte. A login
 * folder's 401 spends that account's own resend, which unfits it, and the walk stays, so the login is made fit again
 * before the send, which may still go sealed to another account with a resend of its own. Any other failure, and a
 * second 401, moves on. None past the last BAA account.
 *
 * @param {Walking} arrival The request on its walk.
 * @param {Aim} aim The send that failed.
 * @param {boolean} rejected Whether it failed on a login folder's 401.
 * @returns {Effect.Effect} The walk to aim down next, or none.
 */
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

/**
 * Route.tla `Reply` when the account answers, `Resend` on the reasoning resend, and `nextAfter` when it fails. Each next send starts
 * from `aimed`. Past the last BAA account the harness gets the last answer as it came, or the request fails with the
 * last failure.
 */
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

/**
 * Route.tla `Dispatch`: the lane log opened, the walk from the session's home account without the open accounts
 * stamped now, and the first send to its first account. The request's one line is written from its walk once the walk
 * ends: when an account answers, when every account failed, or when the harness hangs up.
 */
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
			const { after, before } = stopped({ aim, spend, walked: now });

			return [before, after];
		});

	const walking: Walking = Struct.assign(arrival, { stopping });

	return yield* aimed(walking, walk).pipe(
		Effect.flatMap((aim) => tried(walking, aim)),
		Effect.onExit(() => Effect.flatMap(Ref.get(walked), (done) => append(lineOf({ arrival, walked: done })))),
	);
});

export { dispatched };
