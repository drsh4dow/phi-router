import { Array, Effect, FileSystem, Path, String as Str, pipe } from "effect";
import type { LaneLogLine } from "#tools/route/mocked-router.ts";
import type { Sent } from "#router/client/mock-upstreams/index.ts";
import { laneLines } from "#tools/route/mocked-router.ts";
import { privacyUnder } from "#tools/route/private.ts";

/** What a run left: every file in the router's state folder, the lane log's text and lines, and what is not private. */
interface Stored {
	readonly files: readonly string[];
	readonly log: string;
	readonly lines: readonly LaneLogLine[];
	/** Each folder under the XDG state and config folders that is not 0700, and each file that is not 0600. */
	readonly notPrivate: readonly string[];
}

const windowWidth = 40;

const windowsOf = (text: string): readonly string[] =>
	pipe(
		Array.makeBy(Math.floor(text.length / windowWidth), (index) => index * windowWidth),
		Array.map((start) => Str.slice(start, start + windowWidth)(text)),
	);

/** A content key is a hex SHA-256. */
const contentKeyLike = /[\da-f]{64}/u;

const isModelPost = ({ method, path }: Sent): boolean => method === "POST" && /\/(?:messages|responses)$/u.test(path);

/** Every file under the router's state folder, the lane log's text and lines, and what under the XDG `roots` is not private. */
const storedIn = Effect.fnUntraced(function* storedIn(folder: string, roots: readonly string[]) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const names = yield* fs.readDirectory(folder, { recursive: true });

	const read = (name: string): Effect.Effect<string> =>
		fs.readFileString(path.join(folder, name)).pipe(Effect.orElseSucceed(() => ""));

	const files = yield* Effect.forEach(names, read, { concurrency: 1 });
	const lines = yield* laneLines(folder);
	const log = yield* read("lanes.jsonl");
	const { notPrivate } = yield* privacyUnder(roots);

	return { files, lines, log, notPrivate } satisfies Stored;
});

/**
 * Whether the lane log has one line per model request an account mock received, and no content key. `laneLines`
 * already fails a line with a field it does not name, and the common checks search every stored file for corpus text.
 *
 * @param {object} run What the state folder holds, and what each account mock received in each turn.
 * @returns {boolean} Whether it holds.
 */
const laneLogHolds = (run: {
	readonly stored: Stored;
	readonly turns: readonly { readonly open: readonly Sent[]; readonly baa: readonly Sent[] }[];
}): boolean => {
	const posts = pipe(
		run.turns,
		Array.flatMap(({ baa, open }) => [...open, ...baa]),
		Array.filter(isModelPost),
	);

	return run.stored.lines.length === posts.length && !contentKeyLike.test(run.stored.log);
};

export { isModelPost, laneLogHolds, storedIn, windowsOf };

export type { Stored };
