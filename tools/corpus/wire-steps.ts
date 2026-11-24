import { Array, Data, Option, Predicate, Record, String as Str, pipe } from "effect";
import type { Case, Message } from "./manifest.ts";
import { isSteering, isText, playedOf } from "./wire-turns.ts";
import type { Played } from "./wire-turns.ts";

const narrativeCap = 12_000;

type Image = Extract<Message, { readonly image: unknown }>["image"];

type SentPrompt = string | { readonly text: string; readonly images: readonly Image[] };

type Step = Data.TaggedEnum<{
	Turn: { readonly prompt: SentPrompt; readonly steer: Option.Option<SentPrompt> };
	Compact: { readonly summary: string };
}>;

const Steps = Data.taggedEnum<Step>();

const fillerMark = "FILLER-TURN";

const fillerLineCount = 250;

const fillerLines = Array.join(
	Array.replicate("The build uses bun and the tests live next to the code.", fillerLineCount),
	"\n",
);

const fillerTurns = 2;

const fillerNumberBase = 1;

const opened = (prompt: SentPrompt): Step => Steps.Turn({ prompt, steer: Option.none() });

const fillers = Array.makeBy(fillerTurns, (index) =>
	opened(
		`${fillerMark} ${String(index + fillerNumberBase)}. Inert filler before a compaction. Reply only ok.\n${fillerLines}`,
	),
);

const summaryPattern =
	/^The conversation history before this point was compacted into the following summary:\s*<summary>(?<inner>[\s\S]*?)<\/summary>\s*$/u;

const summaryOf = (text: string): Option.Option<string> =>
	pipe(
		Str.match(summaryPattern)(text),
		Option.flatMapNullishOr(({ groups }) => groups),
		Option.flatMap(Record.get("inner")),
		Option.map(Str.trim),
		Option.filter((summary) => summary.length <= narrativeCap),
	);

const withImage = (sent: SentPrompt, image: Image): SentPrompt => {
	if (Predicate.isString(sent)) {
		return { images: [image], text: sent };
	}

	return { images: [...sent.images, image], text: sent.text };
};

const neutralOpening = opened("Go on with the task.");

const pinnedReply = [opened("/phi pin"), neutralOpening, opened("/phi unpin")];

const addedSteps = (message: Message): readonly Step[] => {
	if (!isText(message)) {
		return [opened(withImage("See the attached image.", message.image))];
	}

	return Option.match(summaryOf(message.text), {
		onNone: () => [opened(message.text)],
		onSome: (summary) => [...fillers, Steps.Compact({ summary }), opened("Continue from the summary.")],
	});
};

const openingOf = ({ leadingReply, walked }: Played): Step[] => {
	const opening: Step[] = [];

	if (Array.isReadonlyArrayNonEmpty(leadingReply)) {
		opening.push(...pinnedReply);
	}

	if (Option.exists(Array.head(walked), ({ message }) => message.role !== "user")) {
		opening.push(neutralOpening);
	}

	return opening;
};

const stepsOf = (subject: Case): Step[] => {
	const played = playedOf(subject);
	const steps = openingOf(played);

	const userTurns = pipe(
		played.walked,
		Array.filter(({ message }) => message.role === "user"),
	);

	for (const { before, message } of userTurns) {
		const joined = pipe(
			Array.last(steps),
			Option.filter(Steps.$is("Turn")),
			Option.flatMap(({ prompt, steer }) => {
				if (isText(message)) {
					const afterTool = Predicate.isNotUndefined(before) && before.role === "tool";

					const steered =
						isSteering(subject) && afterTool && Option.isNone(steer) && Option.isNone(summaryOf(message.text));

					return Option.liftPredicate(Steps.Turn({ prompt, steer: Option.some(message.text) }), () => steered);
				}

				const { image } = message;

				return Option.some(
					Option.match(steer, {
						onNone: () => Steps.Turn({ prompt: withImage(prompt, image), steer }),
						onSome: (sent) => Steps.Turn({ prompt, steer: Option.some(withImage(sent, image)) }),
					}),
				);
			}),
		);

		if (Option.isSome(joined)) {
			steps.pop();
			steps.push(joined.value);
		} else {
			steps.push(...addedSteps(message));
		}
	}

	return steps;
};

export { fillerMark, narrativeCap, stepsOf, Steps, summaryOf };

export type { SentPrompt, Step };
