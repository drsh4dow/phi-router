import { Context, Effect, Layer } from "effect";
import { LaneChoice, pinning } from "#router/features/lanes/index.ts";
import { defaultJudgeModel, policyVersion } from "#router/features/policy/index.ts";
import { Configuration } from "#router/client/configuration.ts";
import { Digest } from "effect/crypto";
import { Judge } from "#router/client/judge.ts";
import { LaneLog } from "#router/client/lane-log.ts";
import { Upstream } from "#router/client/upstream-served.ts";
import { VerdictStore } from "#router/client/verdict-store.ts";

/** What every harness shares, built once, when the router starts. */
interface Routing {
	/** `policyVersion` of the configured judge model, so verdicts another judge model made are not reused. */
	readonly policy: string;
	readonly choose: typeof LaneChoice.Service;
	readonly store: VerdictStore["Service"];
	readonly laneLog: LaneLog["Service"];
	/** The exact texts the configuration lists as fixtures. */
	readonly fixtures: readonly string[];
	/** Why a request is pinned, given its session's pin from the arrival read and the request, with the configured BAA repos. */
	readonly pinnedBy: Effect.Success<ReturnType<typeof pinning>>;
}

/** What judging and keying a request needs while it is handled. */
type Judging = Judge | Digest.Digest;

/** The judge and the digest of the build context, and nothing else, so each request keeps the scope its server gives it. */
const judgingOf = Effect.map(Effect.context<Judging>(), Context.pick(Judge, Digest.Digest));

/** The services only a serving router builds: the judge and the accounts, which read their keys, and the lane log. */
const services = Layer.mergeAll(Judge.layer, Upstream.layer, LaneLog.layer, Digest.layerWebCrypto).pipe(
	Layer.provideMerge(Configuration.layer({ judgeModel: defaultJudgeModel })),
);

const routing = Effect.gen(function* routing() {
	const configuration = yield* Configuration;

	return {
		choose: yield* LaneChoice,
		fixtures: configuration.fixtures,
		laneLog: yield* LaneLog,
		pinnedBy: yield* pinning(configuration.baaRepos),
		policy: yield* policyVersion(configuration.judge.model),
		store: yield* VerdictStore,
	} satisfies Routing;
});

export { judgingOf, routing, services };

export type { Judging, Routing };
