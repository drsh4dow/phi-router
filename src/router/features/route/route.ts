import { Array, Effect, Option, Schema, Stream, Struct, pipe } from "effect";
import type { Arrived, Choice } from "./send.ts";
import type { Decoded, HarnessWire, Serving } from "./harness.ts";
import { Findings, Fixtures, Verdicts, standingOf } from "#router/features/verdicts/index.ts";
import type { Incoming, Outgoing, Path } from "#router/client/router-port/index.ts";
import { catalogQuery, catalogWith, fromCodex } from "#router/features/codex/index.ts";
import type { Judging } from "./routing.ts";
import type { Lookup } from "#router/features/verdicts/index.ts";
import type { OpenAiAccounts } from "#router/client/accounts/index.ts";
import type { Scope } from "effect";
import { SessionId } from "#shared/cli.ts";
import { auto } from "./send.ts";
import { dispatched } from "./failover.ts";
import { wires } from "./harness.ts";

const statuses = { failed: 500, notFound: 404, ok: 200, refused: 502, unreadable: 400 } as const;

/** The answer to a path the router lacks (ADR 0001). */
const notFound: Outgoing = { body: Stream.empty, headers: {}, kind: "relayed", status: statuses.notFound };

/**
 * An answer the router makes itself, in the error shape of the harness's vendor.
 *
 * @param {HarnessWire} wire The harness.
 * @param {number} status The status.
 * @param {string} message What went wrong. It names a field or an account, never a value.
 * @returns {Effect.Effect<Outgoing>} The answer.
 */
const refusal = (wire: HarnessWire, status: number, message: string): Effect.Effect<Outgoing> =>
	Effect.map(wire.errorBody(status, message), (body) => ({ body, kind: "whole", status }));

/** The failures that say the judge itself gave no usable answer. A binary or too-large piece is sealed without asking it. */
const judgeFailed = new Set(["judge-error", "judge-timeout", "judge-refused"]);

const isJudgeFailure = Verdicts.$match({
	Cleared: () => false,
	Sealed: ({ finding }) => Findings.$is("Failure")(finding) && judgeFailed.has(finding.why),
});

/** A request that judged nothing counts no judge cost and no failure on its lane log line. */
const unjudged = { cost: 0, failures: 0 } as const;

/**
 * Route.tla `Arrive`: every part `lookup` does not hold judged, history included, the listed fixtures cleared. `Store`:
 * all the judgments in one step.
 */
const judgedOn = Effect.fnUntraced(function* judgedOn(
	serving: Serving,
	session: string,
	{ lookup, messages }: { readonly lookup: Lookup; readonly messages: Decoded["messages"] },
) {
	const { found, laneAt, usage } = yield* Effect.provideService(
		serving.choose({ lookup, messages }),
		Fixtures,
		serving.fixtures,
	);

	yield* serving.store.record(
		session,
		serving.policy,
		pipe(
			found,
			Array.map(([key, verdict]) => [key, standingOf(verdict)] as const),
		),
	);

	const failures = Array.countBy(found, ([, verdict]) => isJudgeFailure(verdict));
	const choice: Choice = { kind: "judged", laneAt };

	return { choice, judged: { cost: usage.cost, failures } };
});

/**
 * Route.tla `Arrive`: one read of the store, and the pin read from it once: the session's, or the request's own when it
 * comes from the pinned subagent. A pinned request judges and stores nothing, so its parts are judged on the first
 * request after the unpin. Codex's thread-title request runs as pinned: it quotes the prompt under a fresh session id,
 * so no pin or BAA repo of its own session can cover it.
 */
const arrived = Effect.fnUntraced(function* arrived(serving: Serving, session: string, incoming: Incoming) {
	const arrival = yield* serving.store.read(session, serving.policy);
	const request = yield* serving.wire.decode(incoming.body, arrival.openWrote);
	const pinned = yield* serving.pinnedBy({ asked: request, pinned: arrival.pinned, session });

	if (Option.isSome(pinned)) {
		const choice: Choice = { by: pinned.value, kind: "pinned" };

		return { choice, incoming, judged: unjudged, request, serving, session } satisfies Arrived;
	}

	const { choice, judged } = yield* judgedOn(serving, session, {
		lookup: arrival.standing,
		messages: request.messages,
	});

	return { choice, incoming, judged, request, serving, session } satisfies Arrived;
});

/**
 * Every failure of an account in the vendor's error shape: 502 naming the account that did not answer, whose login
 * ended, with the command that fixes it, or whose login folder's token was refused twice.
 *
 * @param {HarnessWire} wire The harness.
 * @returns {object} The handlers, by tag.
 */
const accountFailures = (wire: HarnessWire) =>
	({
		LoginEnded: ({ message }: { readonly message: string }) => refusal(wire, statuses.refused, message),
		Rejected: ({ account }: { readonly account: string }) =>
			refusal(wire, statuses.refused, `account ${account} refused its login folder's token`),
		UpstreamRefused: ({ account }: { readonly account: string }) =>
			refusal(wire, statuses.refused, `account ${account} did not answer`),
	}) as const;

/**
 * One model request of one harness end to end: `Arrive`, then `Dispatch` and each send after it, the answer relayed
 * unbuffered. Every failure is an answer in the vendor's error shape: 400 with no session header or an unreadable body,
 * or with the line that names the setup command when a BAA account refused its key, since each harness shows a 400's
 * message as it came and none takes it for its own login, 500 when the store, the lane log or the 429 stamps fail, 502
 * when no account up to the last BAA account answered.
 * An unreadable body never falls back to the sealed lane.
 *
 * @param {Serving} serving The harness served.
 * @returns {Function} The answer to one request.
 */
const answering =
	(serving: Serving) =>
	(incoming: Incoming): Effect.Effect<Outgoing, never, Judging | Scope.Scope> => {
		const { wire } = serving;

		return Option.match(Schema.decodeUnknownOption(SessionId)(incoming.headers[wire.sessionHeader]), {
			onNone: () => refusal(wire, statuses.unreadable, `phi-router needs ${wire.sessionHeader}`),
			onSome: (session) =>
				arrived(serving, session, incoming).pipe(
					Effect.flatMap(dispatched),
					Effect.catchTags(accountFailures(wire)),
					Effect.catchTags({
						BaaKeyRefused: ({ message }) => refusal(wire, statuses.unreadable, message),
						PlatformError: () => refusal(wire, statuses.failed, "phi-router could not write its state"),
						SchemaError: () => refusal(wire, statuses.failed, "phi-router could not read its state"),
						Unreadable: ({ reason }) => refusal(wire, statuses.unreadable, reason),
					}),
				),
		});
	};

/** The first open account's model catalog, asked with `query` alone, with `phi/auto` appended. */
const listedWith = Effect.fnUntraced(function* listedWith(
	accounts: OpenAiAccounts,
	incoming: Incoming,
	query: Readonly<Record<string, string>>,
) {
	const answer = yield* accounts.catalog({ headers: incoming.headers, query });

	if (answer.status !== statuses.ok) {
		return Struct.assign(answer, { kind: "relayed" as const }) satisfies Outgoing;
	}

	const text = yield* Stream.mkString(Stream.decodeText(answer.body));
	const listed = yield* catalogWith({ copyOf: accounts.targetModel, slug: auto })(text);

	return yield* Option.match(listed, {
		onNone: () => refusal(wires.codex, statuses.refused, `the catalog lists no ${accounts.targetModel}`),
		onSome: (body) => Effect.succeed({ body, kind: "whole", status: statuses.ok } satisfies Outgoing),
	});
});

/**
 * `GET /v1/models`: the first open account's model catalog, asked with the harness's headers, with `phi/auto` appended as a
 * copy of the target model's entry. Another status is relayed as it came. 502 when the account does not answer, its
 * login ended, or its catalog lists no target model. A request not from Codex gets the 404 of a path the router lacks and reaches no
 * account, so Claude Code's model discovery never carries its login to OpenAI. A `client_version` without the shape of
 * a version gets 400 and reaches no account.
 *
 * @param {OpenAiAccounts} accounts OpenAI's accounts.
 * @returns {Path["answer"]} The answer to one request.
 */
const models =
	(accounts: OpenAiAccounts): Path["answer"] =>
	(incoming) => {
		if (!fromCodex(incoming.headers)) {
			return Effect.succeed(notFound);
		}

		return Option.match(catalogQuery(incoming.query), {
			onNone: () =>
				refusal(wires.codex, statuses.unreadable, "phi-router forwards client_version only as a version"),
			onSome: (query) => listedWith(accounts, incoming, query).pipe(Effect.catchTags(accountFailures(wires.codex))),
		});
	};

export { answering, models, notFound, statuses };
