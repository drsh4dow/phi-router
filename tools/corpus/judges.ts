import { Console, Context, DateTime, Effect, FileSystem, Layer, pipe } from "effect";
import type { PlatformError, Schema } from "effect";
import { recordedJudge, recording, recordingsPath } from "./recorded.ts";
import { Configuration } from "#router/client/configuration.ts";
import { Judge } from "#router/client/judge.ts";
import { liveJudge } from "#tools/judge/live.ts";

/**
 * Which judge a corpus run asks, and the recordings file named by a flag, or undefined for the one kept beside this
 * file. `recorded` answers from that file. `live` with `record` writes its answers to it.
 */
type JudgeChoice =
	| { readonly name: "recorded"; readonly recordings: string | undefined }
	| { readonly name: "live"; readonly record: boolean; readonly recordings: string | undefined };

/** What a corpus run asks: the judge, its count of calls it had no answer for, and the step that runs after the corpus. */
interface Asked {
	readonly judge: Judge["Service"];
	readonly unrecorded: Effect.Effect<number>;
	readonly writeRecordings: Effect.Effect<void, PlatformError.PlatformError | Schema.SchemaError>;
}

const noUnrecordedCalls = 0;

const liveUnrecorded = Effect.succeed(noUnrecordedCalls);

const replayOf = Effect.fn("replayOf")(function* replayOf(recordings: string) {
	const fs = yield* FileSystem.FileSystem;
	const contents = yield* fs.readFileString(recordings);
	const { judge, unrecorded } = yield* recordedJudge(contents);

	return { judge, unrecorded, writeRecordings: Effect.void } satisfies Asked;
});

const liveOf = Effect.fn("liveOf")(function* liveOf(record: boolean, recordings: string) {
	const fs = yield* FileSystem.FileSystem;
	const built = yield* Layer.build(liveJudge);
	const { endpoint, model } = Context.get(built, Configuration).judge;
	const started = yield* DateTime.now;

	yield* Console.log(`live judge ${endpoint}, model ${model}, started ${DateTime.formatIso(started)}`);

	if (!record) {
		return {
			judge: Context.get(built, Judge),
			unrecorded: liveUnrecorded,
			writeRecordings: Effect.void,
		} satisfies Asked;
	}

	const recorder = yield* recording(Context.get(built, Judge));

	const writeRecordings = pipe(
		recorder.contents,
		Effect.flatMap((contents) => fs.writeFileString(recordings, contents)),
	);

	return { judge: recorder.judge, unrecorded: liveUnrecorded, writeRecordings } satisfies Asked;
});

/**
 * The judge a corpus run asks. `recorded` answers from the recordings. `live` asks the judge the router's
 * configuration file names, which answers every call and costs money, and prints that judge's endpoint, model and
 * start time.
 *
 * @param {JudgeChoice} choice Which judge to ask.
 * @returns {Effect.Effect} The judge, the count of calls it could not answer and the step after the corpus.
 */
const judgeOf = (choice: JudgeChoice): ReturnType<typeof liveOf> | ReturnType<typeof replayOf> => {
	const recordings = choice.recordings ?? recordingsPath;

	if (choice.name === "live") {
		return liveOf(choice.record, recordings);
	}

	return replayOf(recordings);
};

export { judgeOf };

export type { JudgeChoice };
