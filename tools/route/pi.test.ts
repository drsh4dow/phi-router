import { Array, Effect, Option, Schema, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { bridgesFor, sealedStub } from "#router/features/border/index.ts";
import { fakes, jsonText } from "./harnesses.ts";
import { NodeServices } from "@effect/platform-node";
import type { Sent as Received } from "#router/client/mock-upstreams/index.ts";
import type { Turn } from "./mocked-router.ts";
import { handleAt } from "#router/primitives/handle.ts";
import { pinnedModel } from "#router/features/lanes/index.ts";
import { routed } from "./mocked-router.ts";

const firstSequence = 1;

const h1 = handleAt(firstSequence);

const canary = "PATIENT-CANARY-3P9W";

const status = { ok: 200, unreadable: 400 } as const;

const AnthropicError = Schema.fromJsonString(
	Schema.Struct({
		error: Schema.Struct({ message: Schema.String, type: Schema.String }),
		type: Schema.Literal("error"),
	}),
);

const turns = {
	answered: { role: "assistant", text: "ok" },
	clean: { role: "user", text: "List the build steps." },
	cleared: { role: "assistant", text: "ok" },
	followUp: { role: "user", text: "Go on." },
	phi: { role: "user", text: `Member ${canary} called.` },
} as const satisfies Record<string, Turn>;

const conversation: readonly (readonly Turn[])[] = [
	[turns.clean],
	[turns.clean, turns.cleared, turns.phi],
	[turns.clean, turns.cleared, turns.phi, turns.answered, turns.followUp],
];

const Block = Schema.Struct({ text: Schema.String });

const Message = Schema.Struct({ content: Schema.Array(Block) });

const Body = Schema.fromJsonString(
	Schema.Struct({ messages: Schema.Array(Message), model: Schema.String, system: Schema.Array(Block) }),
);

const piBodyOnAuto = (sent: readonly Turn[]): Effect.Effect<string> =>
	jsonText({
		max_tokens: 1024,
		messages: pipe(
			sent,
			Array.map(({ role, text }) => ({ content: [{ text, type: "text" }], role })),
		),
		model: "auto",
		stream: true,
	});

const viewOf = Effect.fnUntraced(function* viewOf(sent: Received) {
	const { messages, model, system } = yield* Schema.decodeEffect(Body)(sent.body);

	return {
		bridge: Array.last(system),
		model,
		texts: pipe(
			messages,
			Array.flatMap(({ content }) => content),
			Array.map(({ text }) => text),
		),
	};
});

const pointsAtSealedModel = (text: string): boolean =>
	Str.includes(pinnedModel)(text) && !Str.includes("/phi pin")(text) && !Str.includes("subagent")(text);

const sealedModelPointed = Effect.sync(() => {
	assert.isTrue(pointsAtSealedModel(bridgesFor.pi), "pi's bridge");
	assert.isTrue(pointsAtSealedModel(sealedStub("pi")(h1)), "pi's stub");
});

const piConversation = Effect.gen(function* piConversation() {
	const { breaches, mocks, post } = yield* routed({ harness: "pi", holdsPhi: Str.includes(canary) });

	const statuses = yield* Effect.forEach(
		conversation,
		Effect.fnUntraced(function* posted(sent) {
			const body = yield* piBodyOnAuto(sent);
			const response = yield* post({ body, session: "pi-1" });

			yield* response.text;

			return response.status;
		}),
		{ concurrency: 1 },
	);

	const opened = yield* mocks.open.received;
	const open = yield* Effect.forEach(opened, viewOf, { concurrency: 1 });
	const sealed = yield* mocks.baa.received;
	const found = yield* breaches;

	assert.deepStrictEqual(statuses, [status.ok, status.ok, status.ok]);
	assert.deepStrictEqual(
		open,
		Array.map(
			[
				[turns.clean.text],
				[turns.clean.text, turns.cleared.text, sealedStub("pi")(h1)],
				[turns.clean.text, turns.cleared.text, sealedStub("pi")(h1), turns.answered.text, turns.followUp.text],
			],
			(texts) => ({
				bridge: Option.some({ text: bridgesFor.pi }),
				model: fakes.targetModel,
				texts,
			}),
		),
	);
	assert.deepStrictEqual(sealed, []);
	assert.deepStrictEqual(found, []);
});

const unmarked = Effect.gen(function* unmarked() {
	const { mocks, post } = yield* routed({ harness: "pi", holdsPhi: Str.includes(canary) });
	const body = yield* piBodyOnAuto([turns.clean]);
	const response = yield* post({ body, session: "" });
	const text = yield* response.text;

	yield* Schema.decodeEffect(AnthropicError)(text);

	assert.strictEqual(response.status, status.unreadable);
	assert.deepStrictEqual([...(yield* mocks.open.received), ...(yield* mocks.baa.received)], []);
});

it.layer(NodeServices.layer)("pi through the router", (test) => {
	test.effect(
		"a clean turn goes open with pi's bridge, and a canary and its follow-up go open with pi's stub in its place",
		() => piConversation,
	);

	test.effect(
		"a request whose session header the hook left empty gets 400 in Anthropic's error shape and reaches no account",
		() => unmarked,
	);

	test.effect(
		"pi's bridge and stub, which the conversation sends, point at the model phi/sealed",
		() => sealedModelPointed,
	);
});
