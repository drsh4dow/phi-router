import { Configuration } from "#router/client/configuration/index.ts";
import { Judge } from "#router/client/judge/index.ts";
import { Layer } from "effect";

const judgeFromConfiguration = Layer.provide(Judge.layer, Configuration.layer);

export { judgeFromConfiguration };
