import { Array, Effect, Option, Schema, pipe } from "effect";
import type { Case, Synthetic as SyntheticList } from "./manifest.ts";
import { Findings, Verdicts, standingOf } from "#router/features/verdicts/index.ts";
import type { Lookup, Standing } from "#router/features/verdicts/index.ts";
import type { Played, Sent } from "./report.ts";
import type { Keep } from "#router/features/border/index.ts";
import { Synthetic } from "#router/features/policy/index.ts";
import { decide } from "#router/features/lanes/index.ts";
import { guard } from "#router/features/border/index.ts";
import { handleAt } from "#router/primitives/handle.ts";
import { reportOf } from "./report.ts";
import { requestMessagesOf } from "./messages.ts";
import { tokensOf } from "./canary-tokens.ts";

type Messages = Parameters<typeof guard>[number]["messages"];

const firstSequence = 1;

interface Book {
	readonly lookup: Lookup;
	readonly record: (standings: readonly (readonly [string, Standing])[]) => void;
}

const casesAtOnce = 8;

const encodeView = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const bodyOf = (messages: Messages): string => Option.getOrElse(encodeView(messages), () => "");

const bookOf = (): Book => {
	const verdicts = new Map<string, Standing>();

	return {
		lookup: (key) => Option.getOrElse(Option.fromNullishOr(verdicts.get(key)), () => "unknown"),
		record: (standings) => {
			for (const [key, standing] of standings) {
				verdicts.set(key, standing);
			}
		},
	};
};

const isFailure = Verdicts.$match({
	Cleared: () => false,
	Sealed: ({ finding }) => Findings.$is("Failure")(finding),
});

const inOrder: Keep<never> = (parts) =>
	pipe(
		parts,
		Array.map(({ key }, index) => [key, handleAt(index + firstSequence)] as const),
		(pairs) => new Map(pairs),
		Effect.succeed,
	);

const guardedBody = Effect.fnUntraced(function* guardedBody(messages: Messages, lookup: Lookup) {
	const guarded = yield* guard({ harness: "claude", keep: inOrder, lookup, messages }).pipe(
		Effect.catchTag("ToolsNotCleared", () => Effect.succeed([])),
	);

	return bodyOf(guarded);
});

const sentOf = Effect.fn("sentOf")(function* sentOf(messages: Messages, book: Book) {
	const decision = yield* decide({ lookup: book.lookup, messages });

	book.record(
		pipe(
			decision.found,
			Array.map(([key, verdict]) => [key, standingOf(verdict)] as const),
		),
	);

	const failures = pipe(
		decision.found,
		Array.filter(([, verdict]) => isFailure(verdict)),
	).length;

	const sealing = pipe(
		decision.found,
		Array.some(([, verdict]) => Verdicts.$is("Sealed")(verdict)),
	);

	const body = yield* guardedBody(messages, book.lookup);

	return { openAccountBody: body, sealedByJudgeFailure: failures, sealing, usage: decision.usage } satisfies Sent;
});

const play = Effect.fn("play")(function* play(subject: Case) {
	const tracked = yield* tokensOf(subject);
	const requests = yield* requestMessagesOf(subject);
	const book = bookOf();
	const sent = yield* Effect.forEach(requests, (messages) => sentOf(messages, book), { concurrency: 1 });

	return { case: subject, sent, tracked } satisfies Played;
});

const evaluate = Effect.fn("evaluate")(function* evaluate({
	cases,
	synthetic,
}: {
	readonly cases: readonly Case[];
	readonly synthetic: SyntheticList;
}) {
	const played = yield* Effect.forEach(cases, (subject) => play(subject), { concurrency: casesAtOnce }).pipe(
		Effect.provideService(Synthetic, synthetic),
	);

	return reportOf(played);
});

export { evaluate, play };
