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

const notFound: Outgoing = { body: Stream.empty, headers: {}, kind: "relayed", status: statuses.notFound };

const refusal = (wire: HarnessWire, status: number, message: string): Effect.Effect<Outgoing> =>
	Effect.map(wire.vendorErrorBody(status, message), (body) => ({ body, kind: "whole", status }));

const judgeFailed = new Set(["judge-error", "judge-timeout", "judge-refused"]);

const isJudgeFailure = Verdicts.$match({
	Cleared: () => false,
	Sealed: ({ finding }) => Findings.$is("Failure")(finding) && judgeFailed.has(finding.why),
});

const unjudged = { cost: 0, failures: 0 } as const;

const judgedOn = Effect.fnUntraced(function* judgedOn(
	serving: Serving,
	session: string,
	{ lookup, messages }: { readonly lookup: Lookup; readonly messages: Decoded["messages"] },
) {
	const { found, usage } = yield* Effect.provideService(
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

	return { cost: usage.cost, failures };
});

const arrived = Effect.fnUntraced(function* arrived(serving: Serving, session: string, incoming: Incoming) {
	const arrival = yield* serving.store.read(session, serving.policy);
	const request = yield* serving.wire.decode(incoming.body, arrival.openWrote);
	const pinned = yield* serving.pinnedBy({ asked: request, session });

	if (Option.isSome(pinned)) {
		const choice: Choice = { by: pinned.value, kind: "pinned" };

		return { choice, incoming, judged: unjudged, request, serving, session } satisfies Arrived;
	}

	const judged = yield* judgedOn(serving, session, {
		lookup: arrival.standing,
		messages: request.messages,
	});

	const choice: Choice = { kind: "judged" };

	return { choice, incoming, judged, request, serving, session } satisfies Arrived;
});

const accountFailures = (wire: HarnessWire) =>
	({
		LoginEnded: ({ message }: { readonly message: string }) => refusal(wire, statuses.refused, message),
		Rejected: ({ account }: { readonly account: string }) =>
			refusal(wire, statuses.refused, `account ${account} refused its login folder's token`),
		UpstreamRefused: ({ account }: { readonly account: string }) =>
			refusal(wire, statuses.refused, `account ${account} did not answer`),
	}) as const;

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
