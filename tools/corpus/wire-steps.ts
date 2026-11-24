import { Array, Data, Option, Predicate, Record, String as Str, pipe } from "effect";
import type { Case, Message } from "./manifest.ts";
import { isSteering, isText, playedOf } from "./wire-turns.ts";
import type { Played } from "./wire-turns.ts";

/** The longest summary narrative pi's compaction keeps, in characters. */
const narrativeCap = 12_000;

/** An image as pi's RPC takes it with a prompt. */
interface Image {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

/** A prompt or steering message as the driver sends it: its text, or its text and images. */
type Sent = string | { readonly text: string; readonly images: readonly Image[] };

type Step = Data.TaggedEnum<{
	/** A prompt; with `steer`, a steering message sent while the prompt's first tool call runs. */
	Turn: { readonly prompt: Sent; readonly steer: Option.Option<Sent> };
	/** Pi's manual compaction, which the mock answers with `summary`. */
	Compact: { readonly summary: string };
}>;

const Steps = Data.taggedEnum<Step>();

type ImageMessage = Extract<Message, { readonly image: unknown }>;

/** A word in every filler prompt, so the mock answers it without spending a scripted reply. */
const fillerMark = "FILLER-TURN";

const fillerLineCount = 250;

const fillerLines = Array.join(
	Array.replicate("The build uses bun and the tests live next to the code.", fillerLineCount),
	"\n",
);

const fillerTurns = 2;

const fillerNumberBase = 1;

const opened = (prompt: Sent): Step => Steps.Turn({ prompt, steer: Option.none() });

/** The filler turns before a compaction, numbered from 1. */
const fillers = Array.makeBy(fillerTurns, (index) =>
	opened(
		`${fillerMark} ${String(index + fillerNumberBase)}. Inert filler before a compaction. Reply only ok.\n${fillerLines}`,
	),
);

const summaryPattern =
	/^The conversation history before this point was compacted into the following summary:\s*<summary>(?<inner>[\s\S]*?)<\/summary>\s*$/u;

/**
 * The text inside a compaction summary message as compaction keeps it, trimmed: what the mock answers the compaction
 * request with. None when the message is no summary, or when its text is longer than compaction keeps, since
 * compaction would replace it and only a pasted turn can carry it.
 *
 * @param {string} text The message's text.
 * @returns {Option.Option<string>} The summary compaction keeps, or none.
 */
const summaryOf = (text: string): Option.Option<string> =>
	pipe(
		Str.match(summaryPattern)(text),
		Option.flatMapNullishOr(({ groups }) => groups),
		Option.flatMap(Record.get("inner")),
		Option.map(Str.trim),
		Option.filter((summary) => summary.length <= narrativeCap),
	);

const imageOf = ({ image }: ImageMessage): Image => ({ data: image.data, mimeType: image.mimeType, type: "image" });

const withImage = (sent: Sent, image: Image): Sent => {
	if (Predicate.isString(sent)) {
		return { images: [image], text: sent };
	}

	return { images: [...sent.images, image], text: sent.text };
};

/** Only a prompt makes pi ask the mock, so a case whose first message is a tool result or a reply opens with this. */
const neutralOpening = opened("Go on with the task.");

const pinnedReply = [opened("/phi pin"), neutralOpening, opened("/phi unpin")];

/**
 * A summary becomes two filler turns, a compaction, and a turn that carries the summary to the next request.
 *
 * @param {Message} message A user message that joins no turn.
 * @returns {readonly Step[]} The steps it adds.
 */
const addedSteps = (message: Message): readonly Step[] => {
	if (!isText(message)) {
		return [opened(withImage("See the attached image.", imageOf(message)))];
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

/**
 * What the driver sends pi for a case. A steering case's message after a tool result steers the last turn, when that
 * turn has none yet and the message is no summary. An image goes with the last turn's steering message, or else with
 * its prompt.
 *
 * @param {Case} subject The case.
 * @returns {Step[]} The steps.
 */
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
					const afterTool = pipe(
						before,
						Array.some((turn) => turn.role === "tool"),
					);

					const steered =
						isSteering(subject) && afterTool && Option.isNone(steer) && Option.isNone(summaryOf(message.text));

					return Option.liftPredicate(Steps.Turn({ prompt, steer: Option.some(message.text) }), () => steered);
				}

				const image = imageOf(message);

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

export type { Sent, Step };
