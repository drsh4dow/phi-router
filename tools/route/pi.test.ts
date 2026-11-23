import { Array, Effect, Option, Schema, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { bridgesFor, stubsFor } from "#router/features/border/index.ts";
import { fakes, jsonText } from "./harnesses.ts";
import { NodeServices } from "@effect/platform-node";
import type { Sent as Received } from "#router/client/mock-accounts.ts";
import type { Turn } from "./mocked-router.ts";
import { routed } from "./mocked-router.ts";

const canary = "PATIENT-CANARY-3P9W";

const status = { ok: 200, unreadable: 400 } as const;

const turns = {
	clean: { role: "user", text: "List the build steps." },
	cleared: { role: "assistant", text: "ok" },
	followUp: { role: "user", text: "Go on." },
	phi: { role: "user", text: `Member ${canary} called.` },
	sealedReply: { role: "assistant", text: "ok" },
} as const satisfies Record<string, Turn>;

const conversation: readonly (readonly Turn[])[] = [
	[turns.clean],
	[turns.clean, turns.cleared, turns.phi],
	[turns.clean, turns.cleared, turns.phi, turns.sealedReply, turns.followUp],
];

const Block = Schema.Struct({ text: Schema.String });

const Message = Schema.Struct({ content: Schema.Array(Block) });

const Body = Schema.fromJsonString(
	Schema.Struct({ messages: Schema.Array(Message), model: Schema.String, system: Schema.Array(Block) }),
);

/**
 * A body as pi sends one on `phi/auto`: the model id inside the provider, one text block per turn.
 *
 * @param {readonly Turn[]} sent The conversation.
 * @returns {Effect.Effect<string>} The body.
 */
const piBodyOf = (sent: readonly Turn[]): Effect.Effect<string> =>
	jsonText({
		max_tokens: 1024,
		messages: pipe(
			sent,
			Array.map(({ role, text }) => ({ content: [{ text, type: "text" }], role })),
		),
		model: "auto",
		stream: true,
	});

/** What the open account read: the last system block, the model, and the text of every message. */
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

/**
 * Whether `text` hands work that needs the identifiers to `/phi pin` and names no subagent, which stock pi lacks.
 *
 * @param {string} text A bridge or a stub.
 * @returns {boolean} Whether it does.
 */
const pointsAtPin = (text: string): boolean => Str.includes("/phi pin")(text) && !Str.includes("subagent")(text);

const pinPointed = Effect.sync(() => {
	assert.isTrue(pointsAtPin(bridgesFor.pi), "pi's bridge");
	assert.isTrue(pointsAtPin(stubsFor.pi), "pi's stub");
});

const piConversation = Effect.gen(function* piConversation() {
	const { breaches, mocks, post } = yield* routed({ harness: "pi", holdsPhi: Str.includes(canary) });

	const statuses = yield* Effect.forEach(
		conversation,
		Effect.fnUntraced(function* posted(sent) {
			const body = yield* piBodyOf(sent);
			const response = yield* post({ body, session: "pi-1" });

			yield* response.text;

			return response.status;
		}),
		{ concurrency: 1 },
	);

	const opened = yield* mocks.open.received;
	const open = yield* Effect.forEach(opened, viewOf, { concurrency: 1 });
	const baa = yield* mocks.baa.received;
	const found = yield* breaches;

	assert.deepStrictEqual(statuses, [status.ok, status.ok, status.ok]);
	assert.deepStrictEqual(
		open,
		Array.map(
			[
				[turns.clean.text],
				[turns.clean.text, turns.cleared.text, stubsFor.pi, turns.sealedReply.text, turns.followUp.text],
			],
			(texts) => ({
				bridge: Option.some({ text: bridgesFor.pi }),
				model: fakes.targetModel,
				texts,
			}),
		),
	);
	assert.deepStrictEqual(
		pipe(
			baa,
			Array.map((sent) => Str.includes(canary)(sent.body)),
		),
		[true],
	);
	assert.deepStrictEqual(found, []);
});

const unmarked = Effect.gen(function* unmarked() {
	const { mocks, post } = yield* routed({ harness: "pi", holdsPhi: Str.includes(canary) });
	const body = yield* piBodyOf([turns.clean]);
	const response = yield* post({ body, session: "" });

	yield* response.text;

	assert.strictEqual(response.status, status.unreadable);
	assert.deepStrictEqual([...(yield* mocks.open.received), ...(yield* mocks.baa.received)], []);
});

it.layer(NodeServices.layer)("pi through the router", (test) => {
	test.effect(
		"a clean turn goes open with pi's bridge, the canary only to the BAA account, and the follow-up carries pi's stub",
		() => piConversation,
	);

	test.effect("a request whose session header the hook left empty reaches no account", () => unmarked);

	test.effect("pi's bridge and stub, which the conversation sends, point at /phi pin", () => pinPointed);
});
