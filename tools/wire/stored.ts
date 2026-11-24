import { Array, Effect, FileSystem, Path, String as Str, pipe } from "effect";
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
	const posts = pipe(
		run.turns,
		Array.flatMap(({ baa, open }) => [...open, ...baa]),
		Array.filter(isModelPost),
	);

	return run.stored.lines.length === posts.length && !contentKeyLike.test(run.stored.laneLogText);
};

export { isModelPost, laneLogHolds, storedIn, windowsOf };

export type { Stored };
