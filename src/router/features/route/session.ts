import type { Accounts, Served } from "#router/client/accounts/index.ts";
import { Array, Effect, Option, Schema, pipe } from "effect";
import type { Outgoing, Path } from "#router/client/router-port/index.ts";
import { SessionId, StatusJson } from "#shared/cli.ts";
import type { Routing } from "./routing.ts";
import type { Status } from "#shared/cli.ts";
import { sessionPaths } from "#router/client/router-port/index.ts";

type LaneAccounts = (typeof Status.Type)["accounts"]["clean"];

const namesOn =
	(lane: "clean" | "sealed", vendor: "anthropic" | "openai") =>
	(accounts: Accounts): LaneAccounts =>
		pipe(
			accounts[lane],
			Array.map(({ name }) => ({ name, vendor })),
		);

const listed = (served: () => Effect.Effect<Served>): Effect.Effect<(typeof Status.Type)["accounts"]> =>
	Effect.map(served(), (now) => {
		const on = (lane: "clean" | "sealed"): LaneAccounts => [
			...Option.match(now.anthropic, { onNone: () => [], onSome: namesOn(lane, "anthropic") }),
			...Option.match(now.openai, { onNone: () => [], onSome: namesOn(lane, "openai") }),
		];

		return { clean: on("clean"), sealed: on("sealed") };
	});

const statuses = { failed: 500, ok: 200, unreadable: 400 } as const;

const answered = (status: number, body: string): Outgoing => ({ body, kind: "whole", status });

const unreadable = answered(statuses.unreadable, '{"error":"unreadable"}');

const failed = answered(statuses.failed, '{"error":"phi-router could not use its state"}');

const sessionRows = ({
	routing,
	served,
}: {
	readonly routing: Routing;
	readonly served: () => Effect.Effect<Served>;
}): readonly Path[] => {
	const status: Path["answer"] = (incoming) =>
		Option.match(Schema.decodeUnknownOption(SessionId)(incoming.query["session"]), {
			onNone: () => Effect.succeed(unreadable),
			onSome: (session) =>
				Effect.gen(function* reported() {
					const summary = yield* routing.store.summary(session, routing.policy);
					const last = yield* routing.laneLog.last(session);
					const accounts = yield* listed(served);

					const body = yield* Schema.encodeEffect(StatusJson)({
						accounts,
						cleared: summary.cleared,
						last: Option.getOrNull(last),
						pinned: false,
						sealed: summary.sealed,
						session,
					});

					return answered(statuses.ok, body);
				}).pipe(Effect.orElseSucceed(() => failed)),
		});

	return [{ answer: status, method: "GET", path: sessionPaths.status }];
};

export { sessionRows };
