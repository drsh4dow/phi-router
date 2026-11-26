import { AccountState, Upstream } from "#router/client/accounts/index.ts";
import { Effect, Layer, Option, Struct, flow } from "effect";
import type { HarnessWire, Serving } from "./harness.ts";
import type { Outgoing, Path } from "#router/client/router-port/index.ts";
import { answerCheck, sessionRows } from "./session.ts";
import { answering, models, notFound, statuses } from "./route.ts";
import { judgingOf, routing, services } from "./routing.ts";
import { piMessages, wires } from "./harness.ts";
import { serve, sessionPaths } from "#router/client/router-port/index.ts";
import { LeaseRegistry } from "#router/client/leases.ts";
import type { OpenAiAccounts } from "#router/client/accounts/index.ts";

const hello: Path["answer"] = () => Effect.succeed({ body: "{}", kind: "whole", status: statuses.ok });

const Router = flow(
	Effect.fnUntraced(function* router(others: readonly Path[]) {
		const accountState = yield* AccountState;
		const routed = yield* routing;
		const shared = Struct.assign(routed, { accountState });
		const { served } = yield* Upstream;
		const context = yield* judgingOf;

		const answer =
			(serving: Serving): Path["answer"] =>
			(incoming) =>
				Effect.provideContext(answering(serving)(incoming), context);

		const anthropic =
			(wire: HarnessWire): Path["answer"] =>
			(incoming) =>
				served.pipe(
					Effect.flatMap((now) =>
						Option.match(now.anthropic, {
							onNone: () => Effect.succeed(notFound),
							onSome: (accounts) => answer(Struct.assign(shared, { accounts, wire }))(incoming),
						}),
					),
				);

		const openai =
			(answerOf: (accounts: OpenAiAccounts) => Path["answer"]): Path["answer"] =>
			(incoming) =>
				served.pipe(
					Effect.flatMap((now) =>
						Option.match(now.openai, {
							onNone: () => Effect.succeed(notFound),
							onSome: (accounts) => answerOf(accounts)(incoming),
						}),
					),
				);

		return serve([
			{ answer: anthropic(wires.claude), method: "POST", path: "/v1/messages" },
			{ answer: anthropic(wires.pi), method: "POST", path: piMessages },
			{
				answer: openai((accounts) => answer(Struct.assign(shared, { accounts, wire: wires.codex }))),
				method: "POST",
				path: "/v1/responses",
			},
			{ answer: openai(models), method: "GET", path: "/v1/models" },
			{ answer: hello, method: "GET", path: "/api/hello" },
			{
				answer: (incoming): Effect.Effect<Outgoing> =>
					Effect.provideContext(answerCheck(shared)(incoming), context),
				method: "POST",
				path: sessionPaths.answerCheck,
			},
			...sessionRows({ routing: shared, served: () => served }),
			...others,
		]);
	}),
	Layer.unwrap,
	Layer.provide(Layer.mergeAll(services, LeaseRegistry.layer, AccountState.layer)),
);

export { Router };

export { stopLines } from "./stopped.ts";

export { piWire } from "#shared/pi.ts";
