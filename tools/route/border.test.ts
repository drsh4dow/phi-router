import { Array, Effect, Schema, String as Str, Struct, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { bodyOf, routed } from "./mocked-router.ts";
import type { LaneChoice } from "#router/features/lanes/index.ts";
import type { Message } from "#router/features/parts/index.ts";
import { NodeServices } from "@effect/platform-node";
import type { Sent as Received } from "#router/client/mock-accounts.ts";
import type { Turn } from "./mocked-router.ts";
import { decide } from "#router/features/lanes/index.ts";
import { stubs } from "#router/features/policy/index.ts";
import { stubsFor } from "#router/features/border/index.ts";

/** Synthetic markers. The judge mock seals a piece holding `sealed` and clears the rest. */
const markers = {
	cleared: "BORDER-CLEARED-5X2P",
	neverJudged: "BORDER-NEVER-JUDGED-3M8T",
	sealed: "BORDER-SEALED-7Q4K",
};

const reply: Turn = { role: "assistant", text: "Noted." };

const cleared: Turn = { role: "user", text: `Plan the release, ticket ${markers.cleared}.` };

const turns: readonly Turn[] = [
	cleared,
	reply,
	{ role: "user", text: `Member ${markers.sealed} called.` },
	reply,
	{ role: "user", text: `Note ${markers.neverJudged}.` },
];

const jsonText = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const hidesNeverJudged = (message: Message): Effect.Effect<boolean> =>
	Effect.map(Effect.orDie(jsonText(message)), (text) => !Str.includes(markers.neverJudged)(text));

/**
 * A wrong lane choice two ways at once: it always answers clean, and it never shows the judge a message that holds
 * `markers.neverJudged`, so that message reaches the border with no stored verdict.
 */
const wrongChoice: typeof LaneChoice.Service = Effect.fnUntraced(function* wrongChoice({ messages, lookup }) {
	const shown = yield* pipe(messages, Effect.filter(hidesNeverJudged));
	const choice = yield* decide({ lookup, messages: shown });

	return Struct.assign(choice, { laneAt: () => "clean" as const });
});

const Block = Schema.Struct({ text: Schema.String });

const Sent = Schema.Struct({ content: Schema.Array(Block) });

const Body = Schema.fromJsonString(Schema.Struct({ messages: Schema.Array(Sent) }));

const textsOf = Effect.fnUntraced(function* textsOf(sent: Received) {
	const { messages } = yield* Schema.decodeEffect(Body)(sent.body);

	return pipe(
		messages,
		Array.flatMap(({ content }) => content),
		Array.map(({ text }) => text),
	);
});

const border = Effect.gen(function* border() {
	const { mocks, post } = yield* routed({ choice: wrongChoice, holdsPhi: Str.includes(markers.sealed) });
	const body = yield* bodyOf(turns);
	const response = yield* post({ body, session: "border-1" });

	yield* response.text;

	const open = yield* mocks.open.received;
	const texts = yield* Effect.forEach(open, (sent) => textsOf(sent), { concurrency: 1 });

	assert.deepStrictEqual(texts, [[cleared.text, reply.text, stubsFor.claude, reply.text, stubs.unknown]]);
});

it.layer(NodeServices.layer)("the border with a wrong lane choice", (test) => {
	test.effect("an open account receives only parts whose key is cleared, and stubs", () => border);
});
