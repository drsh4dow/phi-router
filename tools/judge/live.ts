import { Configuration } from "#router/client/configuration.ts";
import { Judge } from "#router/client/judge.ts";
import { Layer } from "effect";
import { defaultJudgeModel } from "#router/features/policy/index.ts";

const configuration = Configuration.layer({ judgeModel: defaultJudgeModel });

const liveJudge = Layer.provideMerge(Judge.layer, configuration);

export { liveJudge };
