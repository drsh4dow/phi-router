import { Configuration } from "#router/client/configuration.ts";
import { Judge } from "#router/client/judge.ts";
import { Layer } from "effect";

/** The judge the router's configuration picks. */
const liveJudge = Layer.provide(Judge.layer, Configuration.layer);

export { liveJudge };
