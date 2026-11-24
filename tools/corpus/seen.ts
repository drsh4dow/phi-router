import { Array, String as Str, pipe } from "effect";
import type { Split, Tracked } from "./canary-tokens.ts";
import { foundIn, messagesOf } from "./request-bodies.ts";

const holds =
	(message: readonly string[]) =>
	(token: string): boolean =>
		pipe(message, Array.some(Str.includes(token)));

type SplitReach = "whole" | "split" | "partial" | "none";

const splitReachOf = (split: Split, openMessages: readonly (readonly string[])[]): SplitReach => {
	const holdsWhole = (message: readonly string[]): boolean =>
		holds(message)(split.canary) || pipe(split.parts, Array.every(holds(message)));

	if (pipe(openMessages, Array.some(holdsWhole))) {
		return "whole";
	}

	const reached = pipe(
		split.parts,
		Array.filter((part) =>
			pipe(
				openMessages,
				Array.some((message) => holds(message)(part)),
			),
		),
	);

	if (reached.length === split.parts.length) {
		return "split";
	}

	if (Array.isReadonlyArrayNonEmpty(reached)) {
		return "partial";
	}

	return "none";
};

interface Seen {
	readonly leaked: readonly string[];
	readonly split: readonly string[];
	readonly unstubbed: readonly string[];
	readonly fragments: readonly string[];
	readonly missing: readonly string[];
}

interface Bodies {
	readonly tracked: Tracked;
	readonly open: readonly string[];
	readonly baa: readonly string[];
}

const seenOn = ({ tracked, open, baa }: Bodies): Seen => {
	const inOpen = foundIn(open);
	const openMessages = pipe(open, Array.flatMap(messagesOf));

	const reaches = pipe(
		tracked.splits,
		Array.map((split) => ({ reach: splitReachOf(split, openMessages), split })),
	);

	const reaching = (reach: SplitReach): Split[] =>
		pipe(
			reaches,
			Array.filter((each) => each.reach === reach),
			Array.map(({ split }) => split),
		);

	const canaries = (reach: SplitReach): string[] =>
		pipe(
			reaching(reach),
			Array.map(({ canary }) => canary),
		);

	const parts = pipe(
		tracked.splits,
		Array.flatMap((split) => split.parts),
	);

	const delivered = [...tracked.wholeCanaryTokens, ...parts, ...tracked.sealedWindows];
	const reached = [...foundIn(baa)(delivered), ...inOpen(parts)];

	return {
		fragments: inOpen([
			...tracked.fragments,
			...pipe(
				reaching("partial"),
				Array.flatMap((split) => split.parts),
			),
		]),
		leaked: Array.dedupe([...inOpen(tracked.wholeCanaryTokens), ...canaries("whole")]),
		missing: [...Array.difference(delivered, reached), ...tracked.untracked],
		split: canaries("split"),
		unstubbed: inOpen(tracked.sealedWindows),
	};
};

export { seenOn };

export type { Seen };
