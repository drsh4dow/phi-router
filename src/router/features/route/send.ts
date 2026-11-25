import { Array, Effect, Exit, Option, Ref, Stream, Struct, flow } from "effect";
import type { Decoded, Serving } from "./harness.ts";
import type { Lane, PinnedBy } from "#router/features/lanes/index.ts";
import type { Digest } from "effect/crypto";
import type { Harness } from "#router/features/border/index.ts";
import type { Incoming } from "#router/client/router-port/index.ts";
import type { Lookup } from "#router/features/verdicts/index.ts";
import type { Reason } from "#router/client/lane-log.ts";
import type { Walk } from "#router/features/accounts/index.ts";
import { guard } from "#router/features/border/index.ts";
import { pinnedModel } from "#router/features/lanes/index.ts";
import { sealedOnly } from "#router/features/accounts/index.ts";

const auto = "phi/auto";

interface Arrived {
	readonly serving: Serving;
	readonly session: string;
	readonly incoming: Incoming;
	readonly request: Decoded;
	readonly pinned: Option.Option<PinnedBy>;
	readonly judged: { readonly cost: number; readonly failures: number };
}

interface SendModel {
	readonly model: string;
	readonly substitute: boolean;
}

interface Sending extends SendModel {
	readonly lane: Lane;
	readonly reason: Reason;
	readonly body: string;
}

const sendingOf = Effect.fnUntraced(function* sendingOf({
	harness,
	lookup,
	models,
	openLeft,
	pinned,
	request,
}: {
	readonly request: Decoded;
	readonly harness: Harness;
	readonly pinned: Option.Option<PinnedBy>;
	readonly models: Readonly<Record<Lane, SendModel>>;
	readonly lookup: Lookup;
	readonly openLeft: boolean;
}) {
	const sealed = (reason: Reason): Effect.Effect<Sending> =>
		Effect.map(
			Effect.orDie(
				request.encode({ lane: "sealed", pinned: Option.isSome(pinned), upstreamModel: models.sealed.model }),
			),
			(body) => Struct.assign(models.sealed, { body, lane: "sealed" as const, reason }),
		);

	if (Option.isSome(pinned)) {
		return yield* sealed(pinned.value);
	}

	const clean: Omit<Sending, "body"> = openLeft
		? Struct.assign(models.clean, { lane: "clean" as const, reason: "clean" as const })
		: Struct.assign(models.sealed, { lane: "sealed" as const, reason: "overflow" as const });

	return yield* guard({ harness, lookup, messages: request.messages }).pipe(
		Effect.flatMap((messages) => request.encode({ lane: "clean", messages, upstreamModel: clean.model })),
		Effect.map((body) => Struct.assign(clean, { body })),
		Effect.catchTags({
			CleanLaneRefused: () => sealed("router failure"),
			ToolsNotCleared: () => sealed("router failure"),
		}),
	);
});

interface Aim {
	readonly send: Sending;
	readonly walk: Walk;
}

const targetOf = (arrival: Arrived): string => {
	const { model } = arrival.request;

	if (model === auto) {
		return arrival.serving.accounts.targetModel;
	}

	if (model === pinnedModel) {
		return arrival.serving.accounts.sealedModel;
	}

	return model;
};

const modelsAt = (at: { readonly arrival: Arrived; readonly walk: Walk }): Readonly<Record<Lane, SendModel>> => {
	const { arrival, walk } = at;
	const { sealedModel } = arrival.serving.accounts;
	const target: SendModel = { model: targetOf(arrival), substitute: false };
	const baa = Array.headNonEmpty(walk.baa);

	if (!Array.contains(baa.lacks, target.model)) {
		return { clean: target, sealed: target };
	}

	return { clean: target, sealed: { model: sealedModel, substitute: true } };
};

const chosen = Effect.fnUntraced(function* chosen(arrival: Arrived, walk: Walk) {
	const { pinned, request, serving, session } = arrival;
	const known = yield* serving.store.read(session, serving.policy);

	const send = yield* sendingOf({
		harness: serving.wire.harness,
		lookup: known.standing,
		models: modelsAt({ arrival, walk }),
		openLeft: Array.isReadonlyArrayNonEmpty(walk.open),
		pinned,
		request,
	});

	const aim: Aim = { send, walk };
	const sealed: Aim = { send, walk: sealedOnly(walk) };

	if (send.lane === "sealed") {
		return sealed;
	}

	return aim;
});

const keepingReplyKeys = Effect.fnUntraced(function* keepingReplyKeys({
	serving,
	session,
}: {
	readonly serving: Serving;
	readonly session: string;
}) {
	const context = yield* Effect.context<Digest.Digest>();
	const text = yield* Ref.make("");
	const decoder = new TextDecoder();

	const kept = Ref.get(text).pipe(
		Effect.flatMap(serving.wire.replyKeys),
		Effect.flatMap((keys) => serving.store.wrote(session, serving.policy, keys)),
		Effect.tapError((failure) => Effect.logWarning(`No reply key kept: ${failure.message}`)),
		Effect.ignore,
		Effect.provideContext(context),
	);

	return flow(
		Stream.tap<Uint8Array, unknown, never, never>((chunk) =>
			Ref.update(text, (all) => all + decoder.decode(chunk, { stream: true })),
		),
		Stream.onExit((exit) => Effect.when(kept, Effect.succeed(Exit.isSuccess(exit)))),
	);
});

export { auto, chosen, keepingReplyKeys, modelsAt, targetOf };

export type { Aim, Arrived };
