import { Array, Effect, FileSystem, Path, Schema, String as Str, pipe } from "effect";
import type { LaneLogLine } from "#tools/route/mocked-router.ts";
import type { Sent } from "#router/client/mock-upstreams/index.ts";
import { laneLines } from "#tools/route/mocked-router.ts";
import { privacyUnder } from "#tools/route/private.ts";

interface Stored {
	readonly fileTexts: readonly string[];
	readonly laneLogText: string;
	readonly lines: readonly LaneLogLine[];
	readonly notPrivate: readonly string[];
}

const windowWidth = 40;

const windowsOf = (text: string): readonly string[] =>
	pipe(
		Array.makeBy(Math.floor(text.length / windowWidth), (index) => index * windowWidth),
		Array.map((start) => Str.slice(start, start + windowWidth)(text)),
	);

const contentKeyLike = /[\da-f]{64}/u;

const isModelPost = ({ method, path }: Sent): boolean => method === "POST" && /\/(?:messages|responses)$/u.test(path);

const overflowing = "List the build steps in one line.";

const isRefused = (sent: Sent): boolean => isModelPost(sent) && Str.includes(overflowing)(sent.body);

const tookOf = ({ baa, open }: { readonly open: readonly Sent[]; readonly baa: readonly Sent[] }): readonly Sent[] => [
	...pipe(
		open,
		Array.filter((sent) => !isRefused(sent)),
	),
	...baa,
];

const Stamps = Schema.fromJsonString(Schema.Struct({ rateLimited: Schema.Struct({ open: Schema.String }) }));

const clockInIso = { end: 16, start: 11 } as const;

const stampClockIn = Effect.fnUntraced(function* stampClockIn(state: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	return yield* fs.readFileString(path.join(state, "accounts.json")).pipe(
		Effect.flatMap(Schema.decodeEffect(Stamps)),
		Effect.map(({ rateLimited }) => Str.slice(clockInIso.start, clockInIso.end)(rateLimited.open)),
		Effect.orElseSucceed(() => "no stamp"),
	);
});

const storedIn = Effect.fnUntraced(function* storedIn(folder: string, roots: readonly string[]) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const names = yield* fs.readDirectory(folder, { recursive: true });

	const read = (name: string): Effect.Effect<string> =>
		fs.readFileString(path.join(folder, name)).pipe(Effect.orElseSucceed(() => ""));

	const fileTexts = yield* Effect.forEach(names, read, { concurrency: 1 });
	const lines = yield* laneLines(folder);
	const laneLogText = yield* read("lanes.jsonl");
	const { notPrivate } = yield* privacyUnder(roots);

	return { fileTexts, laneLogText, lines, notPrivate } satisfies Stored;
});

const laneLogHolds = (run: {
	readonly stored: Stored;
	readonly turns: readonly { readonly open: readonly Sent[]; readonly baa: readonly Sent[] }[];
}): boolean => {
	const posts = pipe(run.turns, Array.flatMap(tookOf), Array.filter(isModelPost));

	return run.stored.lines.length === posts.length && !contentKeyLike.test(run.stored.laneLogText);
};

export { isModelPost, isRefused, laneLogHolds, overflowing, stampClockIn, storedIn, tookOf, windowsOf };

export type { Stored };
