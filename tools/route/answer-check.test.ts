import { Array, Effect, Schema, String as Str, pipe } from "effect";
import { AnswerCheckJson, AnswerCheckedJson, StatusJson } from "#shared/cli.ts";
import { HttpClient, HttpClientRequest } from "effect/http";
import { assert, it } from "@effect/vitest";
import { bodyOf, routed } from "./mocked-router.ts";
import { NodeServices } from "@effect/platform-node";
import type { Reply } from "#router/client/mock-upstreams/index.ts";
import { pinnedModel } from "#router/features/lanes/index.ts";
import { sessionPaths } from "#router/client/router-port/index.ts";

const session = "answers-1";

const ssn = "078-05-1120";

const canary = "CANARY-PAT-7316";

const cleanAnswer = "patient_id 4471 has 3 open claims.";

const ruleAnswer = `The member's SSN is ${ssn}.`;

const judgedAnswer = `The member is ${canary}.`;

const judgeNaming = (piece: string): Reply => {
	const holds = Str.includes(canary)(piece);

	return {
		body: {
			answers: [
				{ name: "identifier", probability: Number(holds), type: "predicate" },
				{ choice: holds ? "patient-name" : "none", confidence: 1, name: "kind", probabilities: [], type: "choice" },
			],
			usage: { input_tokens: 1 },
		},
		kind: "body",
	};
};

const checker = Effect.gen(function* checker() {
	const { client, mocks, post, state } = yield* routed({ holdsPhi: Str.includes(canary), judge: judgeNaming });

	const checked = Effect.fnUntraced(function* checked(subagent: string, answer: string) {
		const body = yield* Schema.encodeEffect(AnswerCheckJson)({ answer, session, subagent });
		const response = yield* client.execute(
			HttpClientRequest.post(sessionPaths.answerCheck).pipe(HttpClientRequest.bodyText(body, "application/json")),
		);
		const text = yield* response.text;

		return yield* Schema.decodeEffect(AnswerCheckedJson)(text);
	});

	const status = Effect.gen(function* status() {
		const response = yield* HttpClient.get(sessionPaths.status, { urlParams: { session } }).pipe(
			Effect.provideService(HttpClient.HttpClient, client),
		);
		const text = yield* response.text;

		return yield* Schema.decodeEffect(StatusJson)(text);
	});

	return { checked, client, mocks, post, state, status };
});

const outcomes = Effect.gen(function* outcomes() {
	const { checked, state, status } = yield* checker;
	const clean = yield* checked("agent-a", cleanAnswer);
	const rule = yield* checked("agent-b", ruleAnswer);
	const judged = yield* checked("agent-c", judgedAnswer);
	const counts = yield* status;
	const folder = `${state}/files/`;

	assert.deepStrictEqual(clean, { outcome: "cleared" });
	assert.deepStrictEqual(
		[rule, judged].map((each) => (each.outcome === "rewrite" ? [each.attempt, each.limit] : each.outcome)),
		[
			[1, 5],
			[1, 5],
		],
	);

	const messages = [rule, judged].map((each) => (each.outcome === "rewrite" ? each.message : ""));

	for (const message of messages) {
		assert.include(message, "This is rewrite attempt 1 of 5");
		assert.include(message, "internal id");
		assert.include(message, "give counts");
		assert.include(message, folder);
	}

	assert.include(messages[0], `it holds a Social Security number (ssn): "${ssn}"`);
	assert.include(
		messages[1],
		"phi-router's judge scored it 1.00 for holding a direct identifier of a patient or member, most likely a real patient's or member's name (patient-name)",
	);
	assert.deepStrictEqual(counts.pinned, { gaveUp: 0, rewrites: 2, runs: 3 });
});

const gaveUp = Effect.gen(function* gaveUp() {
	const { checked, mocks, post, status } = yield* checker;
	const answers = yield* Effect.forEach(
		Array.makeBy(7, () => ruleAnswer),
		(answer) => checked("agent-d", answer),
		{
			concurrency: 1,
		},
	);
	const cleared = yield* checked("agent-d", cleanAnswer);
	const again = yield* checked("agent-d", ruleAnswer);
	const counts = yield* status;

	assert.deepStrictEqual(
		answers.map((each) => (each.outcome === "rewrite" ? each.attempt : each.outcome)),
		[1, 2, 3, 4, 5, "gave-up", "gave-up"],
	);

	const [sixth, seventh] = pipe(answers, Array.drop(5));
	const handles = [sixth, seventh].map((each) => (each?.outcome === "gave-up" ? each.handle : ""));

	assert.deepStrictEqual(handles, ["h1", "h2"]);
	assert.strictEqual(
		sixth?.outcome === "gave-up" ? sixth.reply : "",
		"[sealed h1] The pinned subagent's answer still held patient identifiers after 5 rewrites, so phi-router could not clear it and withheld it. h1 is its handle.",
	);
	assert.deepStrictEqual(
		[cleared, again.outcome === "rewrite" ? again.attempt : again.outcome],
		[{ outcome: "cleared" }, 1],
	);
	assert.deepStrictEqual(counts.pinned, { gaveUp: 2, rewrites: 6, runs: 1 });

	const pinned = yield* bodyOf([{ role: "user", text: "Summarize h1 by internal ids." }]);
	const asked = yield* post({ body: Str.replace('"model":"phi/auto"', `"model":"${pinnedModel}"`)(pinned), session });

	yield* asked.text;

	const sealed = yield* mocks.baa.received;

	assert.isTrue(Array.some(sealed, ({ body }) => Str.includes(`[content of h1]\\n${ruleAnswer}\\n[end of h1]`)(body)));
});

const unreadable = Effect.gen(function* unreadable() {
	const { client } = yield* checker;
	const response = yield* client.execute(
		HttpClientRequest.post(sessionPaths.answerCheck).pipe(
			HttpClientRequest.bodyText('{"answer":"x"}', "application/json"),
		),
	);

	assert.strictEqual(response.status, 400);
});

it.layer(NodeServices.layer)("the answer check", (test) => {
	test.effect(
		"clears an answer with internal ids only, and asks for rewrite 1 of 5 naming the rule's kind and value or the judge's kind and score, with the way out, counted per subagent",
		() => outcomes,
	);
	test.effect(
		"gives up after the fifth rewrite, seals the answer under a handle the pinned subagent can open, keeps giving up until a clean answer, and counts it all in status",
		() => gaveUp,
	);
	test.effect("refuses a request that is not the contract's", () => unreadable);
});
