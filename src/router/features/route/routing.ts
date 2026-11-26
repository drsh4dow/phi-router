import { Context, Effect, Layer } from "effect";
import { LaneChoice, pinning } from "#router/features/lanes/index.ts";
import { Configuration } from "#router/client/configuration/index.ts";
import { Digest } from "effect/crypto";
import { Judge } from "#router/client/judge/index.ts";
import { LaneLog } from "#router/client/lane-log.ts";
import type { Pinning } from "#router/features/lanes/index.ts";
import { SealedStore } from "#router/client/sealed-store.ts";
import { Upstream } from "#router/client/accounts/index.ts";
import { VerdictStore } from "#router/client/verdict-store.ts";
import { policyVersion } from "#router/features/policy/index.ts";

interface Routing {
	readonly policy: string;
	readonly choose: typeof LaneChoice.Service;
	readonly store: VerdictStore["Service"];
	readonly sealedStore: SealedStore["Service"];
	readonly laneLog: LaneLog["Service"];
	readonly fixtures: readonly string[];
	readonly pinnedBy: Pinning;
}

type Judging = Judge | Digest.Digest;

const judgingOf = Effect.map(Effect.context<Judging>(), Context.pick(Judge, Digest.Digest));

const services = Layer.mergeAll(
	Judge.layer,
	Upstream.layer,
	LaneLog.layer,
	SealedStore.layer,
	Digest.layerWebCrypto,
).pipe(Layer.provideMerge(Configuration.layer));

const routing = Effect.gen(function* routing() {
	const configuration = yield* Configuration;
	const judge = yield* Judge;

	return {
		choose: yield* LaneChoice,
		fixtures: configuration.fixtures,
		laneLog: yield* LaneLog,
		pinnedBy: yield* pinning(configuration.baaRepos),
		policy: yield* policyVersion(judge),
		sealedStore: yield* SealedStore,
		store: yield* VerdictStore,
	} satisfies Routing;
});

export { judgingOf, routing, services };

export type { Judging, Routing };
