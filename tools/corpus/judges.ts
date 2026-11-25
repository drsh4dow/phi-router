import { Console, Context, DateTime, Effect, FileSystem, Layer, pipe } from "effect";
import type { PlatformError, Schema } from "effect";
import { recordedJudge, recording, recordingsPath } from "./recorded.ts";
import { Judge } from "#router/client/judge/index.ts";
import { judgeFromConfiguration } from "#tools/judge/live.ts";

type JudgeChoice =
	| { readonly name: "recorded"; readonly recordings?: string | undefined }
	| {
			readonly name: "live";
			readonly record: boolean;
			readonly recordings?: string | undefined;
	  };

interface CorpusJudge {
	readonly judge: Judge["Service"];
	readonly unrecorded: Effect.Effect<number>;
	readonly writeRecordings: Effect.Effect<void, PlatformError.PlatformError | Schema.SchemaError>;
}

const noUnrecordedCalls = 0;

const liveUnrecorded = Effect.succeed(noUnrecordedCalls);

const replayOf = Effect.fn("replayOf")(function* replayOf(recordings: string | undefined) {
	const fs = yield* FileSystem.FileSystem;
	const contents = yield* fs.readFileString(recordings ?? recordingsPath);
	const { judge, unrecorded } = yield* recordedJudge(contents);

	return { judge, unrecorded, writeRecordings: Effect.void } satisfies CorpusJudge;
});

const liveOf = Effect.fn("liveOf")(function* liveOf(
	choice: Omit<Extract<JudgeChoice, { readonly name: "live" }>, "name">,
) {
	const fs = yield* FileSystem.FileSystem;

	const built = yield* Layer.build(judgeFromConfiguration);

	const judge = Context.get(built, Judge);
	const started = yield* DateTime.now;

	yield* Console.log(`live judge decisions, model ${judge.model}, started ${DateTime.formatIso(started)}`);

	if (!choice.record) {
		return { judge, unrecorded: liveUnrecorded, writeRecordings: Effect.void } satisfies CorpusJudge;
	}

	const recorder = yield* recording(judge);

	const writeRecordings = pipe(
		recorder.contents,
		Effect.flatMap((contents) => fs.writeFileString(choice.recordings ?? recordingsPath, contents)),
	);

	return { judge: recorder.judge, unrecorded: liveUnrecorded, writeRecordings } satisfies CorpusJudge;
});

const judgeOf = (choice: JudgeChoice): ReturnType<typeof liveOf> | ReturnType<typeof replayOf> => {
	if (choice.name === "live") {
		return liveOf(choice);
	}

	return replayOf(choice.recordings);
};

export { judgeOf };

export type { JudgeChoice };
