import { Effect, FileSystem, Path, Schema, String as Str } from "effect";
import { Reasons } from "#router/client/lane-log.ts";

/** A lane log line: these fields and no other, so no line can carry content. */
const LaneLine = Schema.fromJsonString(
	Schema.Struct({
		account: Schema.String,
		judgeCost: Schema.Finite,
		judgeFailures: Schema.Int,
		lane: Schema.Literals(["clean", "sealed"]),
		model: Schema.String,
		reason: Reasons,
		session: Schema.String,
		substitute: Schema.Boolean,
		time: Schema.String,
	}),
);

/** The lines of the lane log in the router's state folder `state`. A line with another field fails. */
const laneLines = Effect.fnUntraced(function* laneLines(state: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const text = yield* fs.readFileString(path.join(state, "lanes.jsonl"));

	return yield* Effect.forEach(
		Str.split(Str.trimEnd(text), "\n"),
		(line) => Schema.decodeEffect(LaneLine)(line, { onExcessProperty: "error" }),
		{ concurrency: 1 },
	);
});

type LaneLogLine = typeof LaneLine.Type;

export { laneLines };

export type { LaneLogLine };
