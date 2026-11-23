import { Array, String as Str, pipe } from "effect";
import type { Split, Tracked } from "./canary-tokens.ts";
import { foundIn, messagesOf } from "./request-bodies.ts";

const holds =
	(message: readonly string[]) =>
	(token: string): boolean =>
		pipe(message, Array.some(Str.includes(token)));

/**
 * How a split canary reached open accounts, judged by the message that carried each part. The human ruled: "an
 * identifier split across a message boundary is an accepted risk; reported, not gated". So a canary is `split`, the
 * accepted risk, only when every part reached an open account and no one message held them all or held the canary
 * whole. A message that holds the canary whole, or holds every part, makes it `whole`, a leak that fails the gate
 * whatever the case's label. Some parts alone are `partial`: fragments, never a leak.
 */
type SplitReach = "whole" | "split" | "partial" | "none";

/**
 * How far a split canary reached the open accounts.
 *
 * @param {Split} split The split canary and its parts.
 * @param {(readonly string[])[]} received The strings of each message open accounts received.
 * @returns {SplitReach} How far it reached.
 */
const splitReachOf = (split: Split, received: readonly (readonly string[])[]): SplitReach => {
	const holdsWhole = (message: readonly string[]): boolean =>
		holds(message)(split.canary) || pipe(split.parts, Array.every(holds(message)));

	if (pipe(received, Array.some(holdsWhole))) {
		return "whole";
	}

	const reached = pipe(
		split.parts,
		Array.filter((part) =>
			pipe(
				received,
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
	/** Complete canary tokens in an open account's body, and split canaries one open-account message held whole. */
	readonly leaked: readonly string[];
	/** Split canaries whose parts reached open accounts only in different messages. Reported, never a leak. */
	readonly split: readonly string[];
	/** Distinctive pieces of canary-holding messages in an open account's body. */
	readonly unsealed: readonly string[];
	/** Fragments, and parts of a split canary that did not all arrive, in an open account's body. Reported, never a leak. */
	readonly fragments: readonly string[];
	/** Tokens no BAA account's body carried, except split parts an open account's body carried as fragments, and untracked canaries. */
	readonly missing: readonly string[];
}

interface Bodies {
	readonly tracked: Tracked;
	/** The bodies open accounts received. */
	readonly open: readonly string[];
	/** The bodies BAA accounts received. */
	readonly baa: readonly string[];
}

const seenOn = ({ tracked, open, baa }: Bodies): Seen => {
	const inOpen = (tokens: readonly string[]): string[] => foundIn({ bodies: open, tokens });
	const received = pipe(open, Array.flatMap(messagesOf));

	const reaches = pipe(
		tracked.splits,
		Array.map((split) => ({ reach: splitReachOf(split, received), split })),
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

	const delivered = [...tracked.complete, ...parts, ...tracked.sealed];
	const reached = [...foundIn({ bodies: baa, tokens: delivered }), ...inOpen(parts)];

	return {
		fragments: inOpen([
			...tracked.fragments,
			...pipe(
				reaching("partial"),
				Array.flatMap((split) => split.parts),
			),
		]),
		leaked: Array.dedupe([...inOpen(tracked.complete), ...canaries("whole")]),
		missing: [...Array.difference(delivered, reached), ...tracked.untracked],
		split: canaries("split"),
		unsealed: inOpen(tracked.sealed),
	};
};

export { seenOn };

export type { Seen };
