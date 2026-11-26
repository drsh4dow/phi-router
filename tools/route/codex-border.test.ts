import { Array, Effect, Schema, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { codexBodyOf, replyMessage, userMessage } from "./harnesses.ts";
import type { LaneChoice } from "#router/features/lanes/index.ts";
import type { Message } from "#router/features/parts/index.ts";
import { NodeServices } from "@effect/platform-node";
import { decide } from "#router/features/lanes/index.ts";
import { handleAt } from "#router/primitives/handle.ts";
import { routed } from "./mocked-router.ts";
import { sealedStub } from "#router/features/border/index.ts";
import { stubs } from "#router/features/policy/index.ts";

const firstSequence = 1;

const h1 = handleAt(firstSequence);

const markers = {
	cleared: "CODEX-BORDER-CLEARED-4H7J",
	neverJudged: "CODEX-BORDER-NEVER-JUDGED-9K3D",
	sealed: "CODEX-BORDER-SEALED-6P1Q",
};

const cleared = `Plan the release, ticket ${markers.cleared}.`;

const input = [
	userMessage(cleared),
	replyMessage({ id: "msg_1", text: "Noted." }),
	userMessage(`Member ${markers.sealed} called.`),
	replyMessage({ id: "msg_2", text: "Noted." }),
	userMessage(`Note ${markers.neverJudged}.`),
];

const jsonText = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const hidesNeverJudged = (message: Message): Effect.Effect<boolean> =>
	Effect.map(Effect.orDie(jsonText(message)), (text) => !Str.includes(markers.neverJudged)(text));

const wrongChoice: typeof LaneChoice.Service = Effect.fnUntraced(function* wrongChoice({ messages, lookup }) {
	const shown = yield* pipe(messages, Effect.filter(hidesNeverJudged));

	return yield* decide({ lookup, messages: shown });
});

const Content = Schema.Array(Schema.Struct({ text: Schema.String }));

const Item = Schema.Struct({ content: Content });

const Sent = Schema.fromJsonString(Schema.Struct({ input: Schema.Array(Item) }));

const textsOf = Effect.fnUntraced(function* textsOf(body: string) {
	const { input: items } = yield* Schema.decodeEffect(Sent)(body);

	return pipe(
		items,
		Array.flatMap(({ content }) => content),
		Array.map(({ text }) => text),
	);
});

const border = Effect.gen(function* border() {
	const { mocks, post } = yield* routed({
		choice: wrongChoice,
		harness: "codex",
		holdsPhi: Str.includes(markers.sealed),
	});

	const body = yield* codexBodyOf(input);
	const response = yield* post({ body, session: "codex-border-1" });

	yield* response.text;

	const open = yield* mocks.open.received;

	const texts = yield* Effect.forEach(open, (sent) => textsOf(sent.body), { concurrency: 1 });

	assert.deepStrictEqual(texts, [[cleared, "Noted.", sealedStub("codex")(h1), "Noted.", stubs.unknown]]);
});

it.layer(NodeServices.layer)("the border with a wrong lane choice, for Codex", (test) => {
	test.effect("an open account receives only parts whose key is cleared, and stubs", () => border);
});
