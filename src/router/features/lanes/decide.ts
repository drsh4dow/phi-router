import { Array, Context, Effect, Option, pipe } from "effect";
import { Findings, Verdicts, quotingReplies, verdictsFor } from "#router/features/verdicts/index.ts";
import type { Lookup } from "#router/features/verdicts/index.ts";
import type { Message } from "#router/features/parts/index.ts";
import { piecesOf } from "#router/features/parts/index.ts";

/** The lane a request runs on: its open accounts, or its BAA accounts. */
type Lane = "clean" | "sealed";

const isSealed = Verdicts.$is("Sealed");

const laneOf = (sealed: boolean): Lane => {
	if (sealed) {
		return "sealed";
	}

	return "clean";
};

/**
 * The verdicts of the parts `lookup` did not know, and the request's lane as a function of the verdict store. A request
 * goes to the sealed lane when a part sealed during it, or when a part of its own new content is stored sealed, as in a
 * retry, a repeated read, or a request of the same session that sealed it meanwhile. A reply that repeats a line of
 * sealed content before it seals as a quote of it. The caller stores `found`, then calls `laneAt` with each send's read
 * of the store. `laneAt` judges nothing and moves only from clean to sealed as the store gains seals.
 */
const decide = Effect.fn("decide")(function* decide({
	messages,
	lookup,
}: {
	readonly messages: readonly Message[];
	readonly lookup: Lookup;
}) {
	const pieces = yield* piecesOf({ messages, sealed: (key) => lookup(key) === "sealed" });

	const judged = pipe(
		pieces,
		Array.map(({ piece }) => piece),
	);

	const verdicts = yield* verdictsFor(judged, (key) => lookup(key) !== "unknown");

	const judgedNow = new Map(verdicts.found);

	const quoting = quotingReplies({
		isSealed: (key) =>
			lookup(key) === "sealed" || Option.exists(Option.fromUndefinedOr(judgedNow.get(key)), isSealed),
		pieces: judged,
	});

	const found = pipe(
		verdicts.found,
		Array.map(([key, verdict]) =>
			Option.match(Option.fromUndefinedOr(quoting.get(key)), {
				onNone: () => [key, verdict] as const,
				onSome: (source) => [key, Verdicts.Sealed({ finding: Findings.Quote({ of: source }) })] as const,
			}),
		),
	);

	const laneAt = (now: Lookup): Lane =>
		laneOf(
			pipe(
				found,
				Array.some(([, verdict]) => isSealed(verdict)),
			) ||
				pipe(
					pieces,
					Array.some(({ own, piece }) => own && now(piece.key) === "sealed"),
				),
		);

	return { found, laneAt, usage: verdicts.usage };
});

/**
 * How the route chooses a lane: `decide` unless a test provides another. The border test provides one that always
 * answers clean and hides a message from judging, to show the border holds when the lane choice is wrong.
 */
const LaneChoice = Context.Reference<typeof decide>("phi-router/router/features/lanes/LaneChoice", {
	defaultValue: () => decide,
});

export { LaneChoice, decide };

export type { Lane };
