import { Configuration } from "#router/client/configuration/index.ts";
import { Judge } from "#router/client/judge/index.ts";
import { Layer } from "effect";

/** The judge the router's configuration picks. */
const liveJudge = Layer.provide(Judge.layer, Configuration.layer);

export { liveJudge };
