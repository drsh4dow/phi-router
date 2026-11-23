import { Array, Option, String as Str, pipe } from "effect";
import type { Entry, Message } from "./manifest.ts";
import type { Random } from "./random.ts";

interface Scene {
	readonly asks: Array.NonEmptyReadonlyArray<string>;
	readonly commands: Array.NonEmptyReadonlyArray<string>;
	readonly paths: Array.NonEmptyReadonlyArray<string>;
}

interface Sample {
	readonly scene: Scene;
	readonly payload: string;
	readonly fragments?: readonly string[];
}

interface Image {
	readonly mimeType: string;
	readonly data: string;
}

interface Delivery {
	readonly entry: typeof Entry.Type;
	readonly scene: Scene;
	readonly parts: readonly [string] | readonly [string, string];
	readonly image?: Image;
	readonly quotes: readonly string[];
	readonly rng: Random;
}

type Role = Message["role"];

type Messages = Array.NonEmptyReadonlyArray<Message>;

const text = (role: Role, body: string): Message => ({ role, text: body });

const imageAfter = (delivery: Delivery, role: Role): readonly Message[] =>
	pipe(
		Option.fromUndefinedOr(delivery.image),
		Option.toArray,
		Array.map((image) => ({ image, role })),
	);

const systemPromptShare = 0.4;

const systemPrompt = (rng: Random): readonly Message[] => {
	if (!rng.chance(systemPromptShare)) {
		return [];
	}

	return [
		text(
			"system",
			"You are a coding agent working in the user's repository. Use the read, bash, edit and write tools.",
		),
	];
};

const steers: Array.NonEmptyReadonlyArray<string> = [
	"Wait, before you rerun it, look at this:",
	"Also, support just sent me this:",
	"Hold on, here's what I'm actually looking at:",
	"One more thing. This is what we got last night:",
];

const busyWork: Array.NonEmptyReadonlyArray<readonly [string, string]> = [
	[
		"Let me run the failing test first.",
		"FAIL test/mapper.test.ts > maps an inbound record\n  expected 1 row, received 0\n\nTests: 1 failed, 41 passed",
	],
	["Building to check the types.", "$ npm run build\n> tsc -p .\n\nFound 0 errors. Watching for file changes."],
	[
		"Searching for where records get rejected.",
		"src/mapper.ts:142:      throw new RecordRejected(row)\nsrc/worker.ts:57:  const rows = batch.map(mapRow)",
	],
];

const fenced = (payload: string): string => `\`\`\`\n${payload}\n\`\`\``;

const viaUser = (delivery: Delivery): Messages => {
	const ask = delivery.rng.pick(delivery.scene.asks);
	const [first, ...rest] = delivery.parts;

	return Array.match(rest, {
		onEmpty: (): Messages => [text("user", `${ask}\n\n${fenced(first)}`), ...imageAfter(delivery, "user")],
		onNonEmpty: ([second]): Messages => [
			text("user", `${ask}\n\n${first}`),
			...imageAfter(delivery, "user"),
			text("user", second),
		],
	});
};

const viaTool =
	(opener: (delivery: Delivery) => Messages, resume: string): ((delivery: Delivery) => Messages) =>
	(delivery: Delivery): Messages => {
		const [first, ...rest] = delivery.parts;

		const resumed = pipe(
			rest,
			Array.flatMap((second) => [text("assistant", resume), text("tool", second)]),
		);

		return [...opener(delivery), text("tool", first), ...imageAfter(delivery, "tool"), ...resumed];
	};

const toolResult = viaTool((delivery): Messages => {
	const command = delivery.rng.pick(delivery.scene.commands);

	return [
		text("user", delivery.rng.pick(delivery.scene.asks)),
		text("assistant", `I'll run \`${command}\` to see it.`),
	];
}, "The output was cut off. Fetching the rest.");

const fileRead = viaTool((delivery): Messages => {
	const path = delivery.rng.pick(delivery.scene.paths);

	return [
		text("user", `${delivery.rng.pick(delivery.scene.asks)} It's in ${path}.`),
		text("assistant", `Reading ${path}.`),
	];
}, "The read stopped at the line limit. Reading the rest with an offset.");

const steering = (delivery: Delivery): Messages => {
	const { rng } = delivery;
	const [doing, output] = rng.pick(busyWork);
	const [first, ...rest] = delivery.parts;

	const resumed = pipe(
		rest,
		Array.flatMap((second) => [text("assistant", "Got it, looking at that now."), text("user", second)]),
	);

	return [
		text("user", rng.pick(delivery.scene.asks)),
		text("assistant", doing),
		text("tool", output),
		text("user", `${rng.pick(steers)}\n\n${first}`),
		...imageAfter(delivery, "user"),
		...resumed,
	];
};

const finished: Array.NonEmptyReadonlyArray<string> = [
	"Reproduced the failure locally.",
	"Wrote a failing test that loads the captured input.",
	"Ruled out the deploy config; staging has the same settings.",
	"Bisected to the commit that changed the mapper.",
];

const underway: Array.NonEmptyReadonlyArray<string> = [
	"Tracing the failing input through the parser.",
	"Comparing the captured input with the schema the importer expects.",
	"Narrowing down which field trips the validation.",
];

const compactionPrefix = "The conversation history before this point was compacted into the following summary:";

const compactionSummary = (delivery: Delivery): Messages => {
	const { rng } = delivery;
	const [first, ...rest] = delivery.parts;

	const summary = Array.join(
		[
			compactionPrefix,
			"",
			"<summary>",
			"## Goal",
			rng.pick(delivery.scene.asks),
			"",
			"## Progress",
			"### Done",
			`- ${rng.pick(finished)}`,
			"### In Progress",
			`- ${rng.pick(underway)}`,
			"",
			"## Critical Context",
			"- The input in question:",
			first,
			"</summary>",
		],
		"\n",
	);

	const resumed = pipe(
		rest,
		Array.flatMap((second) => [
			text("assistant", `Re-running \`${rng.pick(delivery.scene.commands)}\` for the rest.`),
			text("tool", second),
		]),
	);

	return [text("user", summary), ...imageAfter(delivery, "user"), ...resumed];
};

const followUps: Array.NonEmptyReadonlyArray<string> = [
	"Thanks. Fix the mapper so it handles that.",
	"Makes sense. Write a failing test for that case first.",
	"Ok, go ahead with the fix and rerun the import.",
];

const linesShownWithoutQuote = 6;

const quoted = ({ parts, quotes }: Delivery): string => {
	const lines = Str.split("\n")(Array.join(parts, ""));

	const holding = pipe(
		lines,
		Array.filter((line) =>
			pipe(
				quotes,
				Array.some((quote) => Str.includes(quote)(line)),
			),
		),
	);

	if (Array.isReadonlyArrayNonEmpty(holding)) {
		return Array.join(holding, "\n");
	}

	return Array.join(Array.take(lines, linesShownWithoutQuote), "\n");
};

const baaAccountReply = (delivery: Delivery): Messages => [
	...fileRead(delivery),
	text(
		"assistant",
		`The record that fails is this one:\n\n${fenced(quoted(delivery))}\n\nIts fields don't match what the mapper expects.`,
	),
	text("user", delivery.rng.pick(followUps)),
];

const frames = {
	"compaction-summary": compactionSummary,
	"ent-reply": baaAccountReply,
	"file-read": fileRead,
	steering,
	"tool-result": toolResult,
	user: viaUser,
} satisfies Record<typeof Entry.Type, (delivery: Delivery) => Messages>;

const converse = (delivery: Delivery): Messages =>
	pipe(systemPrompt(delivery.rng), Array.appendAll(frames[delivery.entry](delivery)));

export { converse };

export type { Image, Sample, Scene };
