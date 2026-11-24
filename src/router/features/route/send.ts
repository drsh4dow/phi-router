import { Array, Effect, Exit, Ref, Stream, Struct, flow } from "effect";
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

/** The model name that stands for the configured target model. Any other name is its own target model. */
const auto = "phi/auto";

/**
 * How a request's lane is chosen, settled on its arrival: pinned, so it runs sealed with nothing judged, or judged, so
 * each send reads its lane from the verdict store.
 */
type Choice =
	| { readonly kind: "pinned"; readonly by: PinnedBy }
	| { readonly kind: "judged"; readonly laneAt: (now: Lookup) => Lane };

/** One request of one session, decoded and judged: what each of its sends is built from. */
interface Arrived {
	readonly serving: Serving;
	readonly session: string;
	readonly incoming: Incoming;
	readonly request: Decoded;
	readonly choice: Choice;
	readonly judged: { readonly cost: number; readonly failures: number };
}

/** The model a send names, and whether it is the substitute for a target model its BAA account lacks. */
interface SendModel {
	readonly model: string;
	readonly substitute: boolean;
}

/** What one send carries, all of it built from one read of the verdict store. */
interface Sending extends SendModel {
	readonly lane: Lane;
	readonly reason: Reason;
	readonly body: string;
}

/**
 * Route.tla `Send`: the body for the lane chosen from one read of the store, built from that same read and naming
 * that lane's model. The border stubs every part that read does not hold cleared. A pinned request goes sealed with no
 * bridge. A request the border or the clean encode refuses goes sealed as a router failure, even with no open account
 * left to try. Any other clean one with no open account left goes sealed for `failover`.
 */
const sendingOf = Effect.fnUntraced(function* sendingOf({
	choice,
	harness,
	lookup,
	models,
	openLeft,
	request,
}: {
	readonly request: Decoded;
	readonly harness: Harness;
	readonly choice: Choice;
	readonly models: Readonly<Record<Lane, SendModel>>;
	readonly lookup: Lookup;
	readonly openLeft: boolean;
}) {
	const sealed = (reason: Reason): Effect.Effect<Sending> =>
		Effect.map(
			Effect.orDie(request.encode({ lane: "sealed", model: models.sealed.model, pinned: choice.kind === "pinned" })),
			(body) => Struct.assign(models.sealed, { body, lane: "sealed" as const, reason }),
		);

	if (choice.kind === "pinned") {
		return yield* sealed(choice.by);
	}

	if (choice.laneAt(lookup) === "sealed") {
		return yield* sealed("sealed new content");
	}

	const clean = (body: string): Effect.Effect<Sending> => {
		if (!openLeft) {
			return sealed("failover");
		}

		return Effect.succeed(Struct.assign(models.clean, { body, lane: "clean" as const, reason: "clean" as const }));
	};

	return yield* guard({ harness, lookup, messages: request.messages }).pipe(
		Effect.flatMap((messages) => request.encode({ lane: "clean", messages, model: models.clean.model })),
		Effect.flatMap(clean),
		Effect.catchTags({
			CleanLaneRefused: () => sealed("router failure"),
			ToolsNotCleared: () => sealed("router failure"),
		}),
	);
});

/** One send, and the walk it leaves: the BAA accounts alone once a send went sealed. */
interface Aim {
	readonly send: Sending;
	readonly walk: Walk;
}

/**
 * The request's target model: the configured one for `phi/auto`, the configured sealed model for `phi/sealed`, else the
 * model the request asked for.
 *
 * @param {Arrived} arrival The request as it arrived.
 * @returns {string} The target model.
 */
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

/**
 * The model each lane's send names while `walk` is where it is. The clean lane names the target model. The sealed lane
 * names the same where the walk's first BAA account carries it, and the substitute where that account lacks it.
 *
 * @param {object} at The request, and the walk whose first BAA account a sealed send goes to.
 * @returns {Record<Lane, SendModel>} The model of each lane.
 */
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

/**
 * Route.tla `Send`: one more read, the lane and the body both from it. The clean lane while the walk has an open
 * account left, else the sealed lane for `failover`. A send that goes sealed drops the open accounts for good.
 */
const chosen = Effect.fnUntraced(function* chosen(arrival: Arrived, walk: Walk) {
	const { choice, request, serving, session } = arrival;
	const known = yield* serving.store.read(session, serving.policy);

	const send = yield* sendingOf({
		choice,
		harness: serving.wire.harness,
		lookup: known.standing,
		models: modelsAt({ arrival, walk }),
		openLeft: Array.isReadonlyArrayNonEmpty(walk.open),
		request,
	});

	const aim: Aim = { send, walk };
	const sealed: Aim = { send, walk: sealedOnly(walk) };

	if (send.lane === "sealed") {
		return sealed;
	}

	return aim;
});

/**
 * What an open account's 200 answer passes through on its way to the harness: its text is collected as it passes, and
 * once the stream completes its reply keys are stored before the body ends. An interrupted stream leaves no key.
 */
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

export type { Aim, Arrived, Choice };
