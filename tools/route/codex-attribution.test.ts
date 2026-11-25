import { Array, Effect, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { codexBodyOf, jsonText, replyMessage, replying, userMessage } from "./harnesses.ts";
import { laneLines, postedIn, routed } from "./mocked-router.ts";
import type { Json } from "./harnesses.ts";
import { NodeServices } from "@effect/platform-node";
import type { Post } from "./mocked-router.ts";
import { pinnedByModel } from "./target-models.ts";
import { stubsFor } from "#router/features/border/index.ts";

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
	const stub = yield* jsonText(stubsFor.codex);
	const stubbed = pipe(opened, Array.map(carries(stub)));

	assert.deepStrictEqual(
		{ judgedEcho: Str.includes(openText)(judged), lanes, opened: canaries, stubbed },
		{
			judgedEcho: false,
			lanes: ["clean", "clean", "clean"],
			opened: [false, false, false],
			stubbed: [false, false, true],
		},
	);
});

const pinnedIn = Effect.fnUntraced(function* pinnedIn(post: Post, session: string, input: readonly Json[]) {
	const body = yield* codexBodyOf(input);
	const response = yield* post({ body: pinnedByModel(body), session });

	yield* response.text;
});

const reused = Effect.gen(function* reused() {
	const baaReply = replyMessage({ id: "msg_1", text: `Noted, ${canary}.` });

	const { mocks, post, state } = yield* routed({
		baa: () => replying([baaReply]),
		harness: "codex",
		holdsPhi: holdsCanary,
		open: () => replying([openReply]),
	});

	yield* postedIn(post, "attribution-2", [asked]);
	yield* pinnedIn(post, "attribution-2", [asked, openReply, phi]);
	yield* postedIn(post, "attribution-2", [asked, openReply, phi, baaReply, followUp]);
	const opened = yield* mocks.open.received;
	const lanes = yield* lanesIn(state);
	const canaries = pipe(opened, Array.map(carries(canary)));

	assert.deepStrictEqual({ lanes, opened: canaries }, { lanes: ["clean", "sealed", "clean"], opened: [false, false] });
});

it.layer(NodeServices.layer)("which account wrote a Codex reply", (test) => {
	test.effect(
		"an echo of an open reply skips the judge, and other text under its item id is judged and reaches the open account as the stub",
		() => tampered,
	);
	test.effect(
		"a BAA reply to a pinned request that reuses an open reply's item id never reaches the open account",
		() => reused,
	);
});
