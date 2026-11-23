import { Effect, Layer, Option, Struct, flow } from "effect";
import type { HarnessWire, Serving } from "./harness.ts";
import { answering, models, notFound, statuses } from "./route.ts";
import { claude, codex, pi, piMessages } from "./harness.ts";
import { judgingOf, routing, services } from "./routing.ts";
import { AccountState } from "#router/client/account-state.ts";
import { LeaseRegistry } from "#router/client/leases.ts";
import type { OpenAiAccounts } from "#router/client/upstream-accounts.ts";
import type { Path } from "#router/client/server.ts";
import { Upstream } from "#router/client/upstream-served.ts";
import { serve } from "#router/client/server.ts";
import { sessionRows } from "./session.ts";

const hello: Path["answer"] = () => Effect.succeed({ body: "{}", kind: "whole", status: statuses.ok });

/**
 * The router on the HTTP server in context. It serves `HEAD /api/hello`, `POST /v1/messages` for Claude Code and
 * `POST /pi/v1/messages` for pi while the configuration names Anthropic accounts, `POST /v1/responses` and Codex's
 * `GET /v1/models` while it names OpenAI accounts, and the session rows of `pin`, `unpin` and `status`. Each request
 * reads the accounts once, when it arrives, so an account added to `config.json` serves the next request. Every other
 * path answers 404 (ADR 0001): `/v1/messages/count_tokens`, so Claude Code falls back to its own estimate, and Codex's
 * WebSocket upgrade on `GET /v1/responses`, so it keeps to HTTP. It builds the configuration, the judge, the accounts, the
 * 429 stamps and the lane log itself, so no other command reads the configuration, runs a key command or reads a login
 * folder. It reads the lease registry the lifecycle writes through its own client, since `start` returns only once a
 * lease is on disk. Still required from outside: the HTTP server, `VerdictStore`, `Callers`, and the platform services.
 * A caller adds its own rows to the table, such as the lease row of `serve`.
 */
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
			{ answer: anthropic(claude), method: "POST", path: "/v1/messages" },
			{ answer: anthropic(pi), method: "POST", path: piMessages },
			{
				answer: openai((accounts) => answer(Struct.assign(shared, { accounts, wire: codex }))),
				method: "POST",
				path: "/v1/responses",
			},
			{ answer: openai(models), method: "GET", path: "/v1/models" },
			{ answer: hello, method: "GET", path: "/api/hello" },
			...sessionRows({ routing: shared, served: () => served }),
			...others,
		]);
	}),
	Layer.unwrap,
	Layer.provide(Layer.mergeAll(services, LeaseRegistry.layer, AccountState.layer)),
);

export { Router };

export { piWire } from "#shared/pi.ts";
