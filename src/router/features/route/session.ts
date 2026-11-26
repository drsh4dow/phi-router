import type { AccountState, Accounts, Served } from "#router/client/accounts/index.ts";
import { AnswerCheckJson, AnswerCheckedJson, SessionId, StatusJson } from "#shared/cli.ts";
import { Array, DateTime, Effect, Option, Schema, Struct, pipe } from "effect";
import type { Incoming, Outgoing, Path } from "#router/client/router-port/index.ts";
import type { Judging, Routing } from "./routing.ts";
import { Fixtures } from "#router/features/verdicts/index.ts";
import type { Status } from "#shared/cli.ts";
import { checkAnswer } from "#router/features/answer-check/index.ts";
import { sessionPaths } from "#router/client/router-port/index.ts";

type LaneAccounts = (typeof Status.Type)["accounts"]["sealed"];

const namesOn =
	(lane: "clean" | "sealed", vendor: "anthropic" | "openai") =>
	(accounts: Accounts): LaneAccounts =>
		pipe(
			accounts[lane],
			Array.map(({ name }) => ({ name, vendor })),
		);

const listed = Effect.fnUntraced(function* listed(
	served: () => Effect.Effect<Served>,
	accountState: AccountState["Service"],
) {
	const now = yield* served();

	const on = (lane: "clean" | "sealed"): LaneAccounts => [
		...Option.match(now.anthropic, { onNone: () => [], onSome: namesOn(lane, "anthropic") }),
		...Option.match(now.openai, { onNone: () => [], onSome: namesOn(lane, "openai") }),
	];

	const open = on("clean");

	const stamps = yield* accountState.stamps(
		pipe(
			open,
			Array.map(({ name }) => name),
		),
	);

	const clean = pipe(
		open,
		Array.map((account) =>
			Option.match(Option.fromUndefinedOr(stamps.get(account.name)), {
				onNone: () => account,
				onSome: (back) => Struct.assign(account, { rateLimitedUntil: DateTime.formatIso(back) }),
			}),
		),
	);

	return { clean, sealed: on("sealed") };
});

const statuses = { failed: 500, ok: 200, unreadable: 400 } as const;

const answered = (status: number, body: string): Outgoing => ({ body, kind: "whole", status });

const unreadable = answered(statuses.unreadable, '{"error":"unreadable"}');

const failed = answered(statuses.failed, '{"error":"phi-router could not use its state"}');

const answerCheck =
	(routing: Routing) =>
	(incoming: Incoming): Effect.Effect<Outgoing, never, Judging> =>
		Option.match(Schema.decodeOption(AnswerCheckJson)(incoming.body), {
			onNone: () => Effect.succeed(unreadable),
			onSome: (asked) =>
				checkAnswer(asked, routing.sealedStore).pipe(
					Effect.flatMap(Schema.encodeEffect(AnswerCheckedJson)),
					Effect.map((body) => answered(statuses.ok, body)),
					Effect.provideService(Fixtures, routing.fixtures),
					Effect.orElseSucceed(() => failed),
				),
		});

const sessionRows = ({
	routing,
	served,
}: {
	readonly routing: Routing & { readonly accountState: AccountState["Service"] };
	readonly served: () => Effect.Effect<Served>;
}): readonly Path[] => {
	const status: Path["answer"] = (incoming) =>
		Option.match(Schema.decodeUnknownOption(SessionId)(incoming.query["session"]), {
			onNone: () => Effect.succeed(unreadable),
			onSome: (session) =>
				Effect.gen(function* reported() {
					const summary = yield* routing.store.summary(session, routing.policy);
					const { last, overflowed } = yield* routing.laneLog.summary(session);
					const pinned = yield* routing.sealedStore.summary(session);
					const accounts = yield* listed(served, routing.accountState);

					const body = yield* Schema.encodeEffect(StatusJson)({
						accounts,
						cleared: summary.cleared,
						last: Option.getOrNull(last),
						overflowed,
						pinned,
						sealed: summary.sealed,
						session,
					});

					return answered(statuses.ok, body);
				}).pipe(Effect.orElseSucceed(() => failed)),
		});

	return [{ answer: status, method: "GET", path: sessionPaths.status }];
};

export { answerCheck, sessionRows };
