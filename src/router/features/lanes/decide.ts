import { Array, Context, Effect, Option, pipe } from "effect";
import { Findings, Verdicts, quotingReplies, verdictsFor } from "#router/features/verdicts/index.ts";
import type { Lookup } from "#router/features/verdicts/index.ts";
import type { Message } from "#router/features/parts/index.ts";
import { piecesOf } from "#router/features/parts/index.ts";

type Lane = "clean" | "sealed";

const isSealed = Verdicts.$is("Sealed");

const laneOf = (sealed: boolean): Lane => {
	if (sealed) {
		return "sealed";
	}

	return "clean";
};

const decide = Effect.fn("decide")(function* decide({
	messages,
	lookup,
}: {
	readonly messages: readonly Message[];
	readonly lookup: Lookup;
}) {
	const judged = yield* piecesOf({ messages, sealed: (key) => lookup(key) === "sealed" });

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

	return { found, usage: verdicts.usage };
});

const LaneChoice = Context.Reference<typeof decide>("phi-router/router/features/lanes/LaneChoice", {
	defaultValue: () => decide,
});

export { LaneChoice, decide, laneOf };

export type { Lane };
