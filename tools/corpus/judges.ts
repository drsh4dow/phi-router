import { Boolean, Console, Context, DateTime, Effect, FileSystem, Layer, pipe } from "effect";
import type { PlatformError, Schema } from "effect";
import { recordedJudge, recording, recordingsPaths } from "./recorded.ts";
import { Judge } from "#router/client/judge/index.ts";
import { liveJudge } from "#tools/judge/live.ts";

/**
 * Which judge a corpus run asks, whether it is the Claude judge, and the recordings file named by a flag, or undefined
 * for the judge's own kept beside this file. `recorded` answers from that file. `live` with `record` writes its answers
 * to it. `live` asks the judge the configuration picks, or the Claude judge on its first Anthropic BAA account.
 */
type JudgeChoice =
	| { readonly name: "recorded"; readonly claude: boolean; readonly recordings: string | undefined }
	| {
			readonly name: "live";
			readonly claude: boolean;
			readonly record: boolean;
			readonly recordings: string | undefined;
	  };

/** What a corpus run asks: the judge, its count of calls it had no answer for, and the step that runs after the corpus. */
interface Asked {
	readonly judge: Judge["Service"];
	readonly unrecorded: Effect.Effect<number>;
	readonly writeRecordings: Effect.Effect<void, PlatformError.PlatformError | Schema.SchemaError>;
}

const noUnrecordedCalls = 0;

const liveUnrecorded = Effect.succeed(noUnrecordedCalls);

const replayOf = Effect.fn("replayOf")(function* replayOf(claude: boolean, recordings: string | undefined) {
	const fs = yield* FileSystem.FileSystem;
	const name = Boolean.match(claude, { onFalse: () => "decisions" as const, onTrue: () => "claude" as const });

	const contents = yield* fs.readFileString(recordings ?? recordingsPaths[name]);
	const { judge, unrecorded } = yield* recordedJudge(contents, name);

	return { judge, unrecorded, writeRecordings: Effect.void } satisfies Asked;
});

const liveOf = Effect.fn("liveOf")(function* liveOf(
	choice: Omit<Extract<JudgeChoice, { readonly name: "live" }>, "name">,
) {
	const fs = yield* FileSystem.FileSystem;

	const built = yield* Layer.build(
		Boolean.match(choice.claude, { onFalse: () => liveJudge, onTrue: () => Judge.claudeLayer }),
	);

	const judge = Context.get(built, Judge);
	const started = yield* DateTime.now;

	yield* Console.log(`live judge ${judge.name}, model ${judge.model}, started ${DateTime.formatIso(started)}`);

	if (!choice.record) {
		return { judge, unrecorded: liveUnrecorded, writeRecordings: Effect.void } satisfies Asked;
	}

	const recorder = yield* recording(judge);

	const writeRecordings = pipe(
		recorder.contents,
		Effect.flatMap((contents) => fs.writeFileString(choice.recordings ?? recordingsPaths[judge.name], contents)),
	);

	return { judge: recorder.judge, unrecorded: liveUnrecorded, writeRecordings } satisfies Asked;
});

/**
 * The judge a corpus run asks. `recorded` answers from the recordings. `live` asks the judge the router's
 * configuration file picks, or the Claude judge, which answers every call and costs money, and prints that judge's name,
 * model and start time.
 *
 * @param {JudgeChoice} choice Which judge to ask.
 * @returns {Effect.Effect} The judge, the count of calls it could not answer and the step after the corpus.
 */
const judgeOf = (choice: JudgeChoice): ReturnType<typeof liveOf> | ReturnType<typeof replayOf> => {
	if (choice.name === "live") {
		return liveOf(choice);
	}

	return replayOf(choice.claude, choice.recordings);
};

export { judgeOf };

export type { JudgeChoice };
