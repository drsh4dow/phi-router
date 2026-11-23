import { Array, Effect, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { jsonText, replyMessage, replying, userMessage } from "./harnesses.ts";
import { laneLines, postedIn, routed } from "./mocked-router.ts";
import { NodeServices } from "@effect/platform-node";

const canary = "PATIENT-CANARY-4K7Q";

const holdsCanary = Str.includes(canary);

const asked = userMessage("List the build steps.");

const followUp = userMessage("Go on.");

const phi = userMessage(`Member ${canary} called.`);

const openText = "Steps: build, then test.";

const openReply = replyMessage({ id: "msg_1", text: openText });

const carries =
	(text: string) =>
	(sent: { readonly body: string }): boolean =>
		Str.includes(text)(sent.body);

const lanesIn = Effect.fnUntraced(function* lanesIn(state: string) {
	const lines = yield* laneLines(state);

	return pipe(
		lines,
		Array.map(({ lane }) => lane),
	);
});

const tampered = Effect.gen(function* tampered() {
	const { mocks, post, state } = yield* routed({
		harness: "codex",
		holdsPhi: holdsCanary,
		open: () => replying([openReply]),
	});

	yield* postedIn(post, "attribution-1", [asked]);
	yield* postedIn(post, "attribution-1", [asked, openReply, followUp]);

	const judged = yield* mocks.judge.received.pipe(Effect.map(Array.map(({ body }) => body)), Effect.flatMap(jsonText));

	const other = replyMessage({ id: "msg_1", text: `Member ${canary} is due.` });

	yield* postedIn(post, "attribution-1", [asked, other, followUp]);
	const opened = yield* mocks.open.received;
	const lanes = yield* lanesIn(state);
	const canaries = pipe(opened, Array.map(carries(canary)));

	assert.deepStrictEqual(
		{ judgedEcho: Str.includes(openText)(judged), lanes, opened: canaries },
		{ judgedEcho: false, lanes: ["clean", "clean", "sealed"], opened: [false, false] },
	);
});

const reused = Effect.gen(function* reused() {
	const baaReply = replyMessage({ id: "msg_1", text: `Noted, ${canary}.` });

	const { mocks, post, state } = yield* routed({
		baa: () => replying([baaReply]),
		harness: "codex",
		holdsPhi: holdsCanary,
		open: () => replying([openReply]),
	});

	const turns = [[asked], [asked, openReply, phi], [asked, openReply, phi, baaReply, followUp]];

	yield* Effect.forEach(turns, (input) => postedIn(post, "attribution-2", input), { concurrency: 1 });
	const opened = yield* mocks.open.received;
	const lanes = yield* lanesIn(state);
	const canaries = pipe(opened, Array.map(carries(canary)));

	assert.deepStrictEqual({ lanes, opened: canaries }, { lanes: ["clean", "sealed", "sealed"], opened: [false] });
});

it.layer(NodeServices.layer)("which account wrote a Codex reply", (test) => {
	test.effect(
		"an echo of an open reply skips the judge, and other text under its item id is judged and goes sealed",
		() => tampered,
	);
	test.effect("a BAA reply that reuses an open reply's item id never reaches the open account", () => reused);
});
