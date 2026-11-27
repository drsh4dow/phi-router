import { Array, Effect, Layer, Match, String as Str, Struct, pipe } from "effect";
import { FetchHttpClient, HttpClientRequest } from "effect/http";
import { SessionRequests, sessionPaths } from "#router/client/router-port/index.ts";
import { assert, it } from "@effect/vitest";
import { bodyOf, routed } from "./mocked-router.ts";
import { NodeServices } from "@effect/platform-node";
import type { Reply } from "#router/client/mock-upstreams/index.ts";
import { identifierKind } from "#router/features/policy/index.ts";
import { pinnedModel } from "#router/features/lanes/index.ts";

const session = "answers-1";

const ssn = "078-05-1120";

const canary = "CANARY-PAT-7316";

const cleanAnswer = "patient_id 4471 has 3 open claims.";

const ruleAnswer = `The member's SSN is ${ssn}.`;

const judgedAnswer = `The member is ${canary}.`;

const firstAttempt = 1;

const rewriteLimit = 5;

const answersSent = 7;

const unreadableStatus = 400;

const kindReply = (holds: boolean, choice: string): Reply => ({
	body: {
		answers: [
			{ name: "identifier", probability: Number(holds), type: "predicate" },
			{ choice, confidence: 1, name: "kind", probabilities: [], type: "choice" },
		],
		usage: { input_tokens: 1 },
	},
	kind: "body",
});

const judgeNaming = (piece: string): Reply => {
	const holds = Str.includes(canary)(piece);

	if (holds) {
		return kindReply(holds, identifierKind.patientName);
	}

	return kindReply(holds, "none");
};

type Checked = Effect.Success<ReturnType<typeof SessionRequests.Service.answerCheck>>;

const attemptOf = Match.type<Checked>().pipe(
	Match.discriminator("outcome")("rewrite", ({ attempt }) => attempt),
	Match.orElse(({ outcome }) => outcome),
);

const attemptAndLimitOf = Match.type<Checked>().pipe(
	Match.discriminator("outcome")("rewrite", ({ attempt, limit }) => [attempt, limit]),
	Match.orElse(({ outcome }) => outcome),
);

const messageOf = Match.type<Checked>().pipe(
	Match.discriminator("outcome")("rewrite", ({ message }) => message),
	Match.orElse(() => ""),
);

const notGivenUp = { handle: "", reply: "" };

const gaveUpOf = Match.type<Checked>().pipe(
	Match.discriminator("outcome")("gave-up", ({ handle, reply }) => ({ handle, reply })),
	Match.orElse(() => notGivenUp),
);

const checker = Effect.gen(function* checker() {
	const { client, mocks, post, state, url } = yield* routed({ holdsPhi: Str.includes(canary), judge: judgeNaming });
	const requests = yield* SessionRequests;
	const port = Number(new URL(url).port);

	const checked = (subagent: string, answer: string): ReturnType<typeof requests.answerCheck> =>
		requests.answerCheck(port, { answer, session, subagent });

	const status = requests.status(port, session);

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
	assert.deepStrictEqual(pipe([rule, judged], Array.map(attemptAndLimitOf)), [
		[firstAttempt, rewriteLimit],
		[firstAttempt, rewriteLimit],
	]);

	const ruleMessage = messageOf(rule);
	const judgedMessage = messageOf(judged);

	for (const message of [ruleMessage, judgedMessage]) {
		assert.include(message, "This is rewrite attempt 1 of 5");
		assert.include(message, "internal id");
		assert.include(message, "give counts");
		assert.include(message, folder);
	}

	assert.include(ruleMessage, `it holds a Social Security number (ssn): "${ssn}"`);
	assert.include(
		judgedMessage,
		"phi-router's judge scored it 1.00 for holding a direct identifier of a patient or member, most likely a real patient's or member's name (patient-name)",
	);

	const pinned = yield* Effect.fromNullishOr(counts.pinned);

	const clearedBy = pipe(
		pinned.cleared,
		Array.map(({ subagent }) => subagent),
	);

	assert.deepStrictEqual(clearedBy, ["agent-a"]);
	assert.deepStrictEqual(Struct.omit(pinned, ["cleared"]), { gaveUp: 0, rewrites: 2, runs: 3, withheld: [] });
});

const gaveUp = Effect.gen(function* gaveUp() {
	const { checked, mocks, post, status } = yield* checker;

	const answers = yield* Effect.forEach(
		Array.makeBy(answersSent, () => ruleAnswer),
		(answer) => checked("agent-d", answer),
		{
			concurrency: 1,
		},
	);

	const withheld = yield* status;
	const cleared = yield* checked("agent-d", cleanAnswer);
	const again = yield* checked("agent-d", ruleAnswer);
	const counts = yield* status;

	assert.deepStrictEqual(pipe(answers, Array.map(attemptOf)), [
		...Array.range(firstAttempt, rewriteLimit),
		"gave-up",
		"gave-up",
	]);

	const [sixth = notGivenUp, seventh = notGivenUp] = pipe(answers, Array.drop(rewriteLimit), Array.map(gaveUpOf));

	assert.deepStrictEqual([sixth.handle, seventh.handle], ["h1", "h2"]);
	assert.strictEqual(
		sixth.reply,
		"[sealed h1] The pinned subagent's answer still held patient identifiers after 5 rewrites, so phi-router could not clear it and withheld it. h1 is its handle.",
	);
	assert.deepStrictEqual([cleared, attemptOf(again)], [{ outcome: "cleared" }, firstAttempt]);
	assert.deepStrictEqual(withheld.pinned, {
		cleared: [],
		gaveUp: 2,
		rewrites: 5,
		runs: 1,
		withheld: [{ reply: seventh.reply, subagent: "agent-d" }],
	});
	assert.deepStrictEqual(counts.pinned, { cleared: [], gaveUp: 2, rewrites: 6, runs: 1, withheld: [] });

	const pinned = yield* bodyOf([{ role: "user", text: "Summarize h1 by internal ids." }]);
	const asked = yield* post({ body: Str.replace('"model":"phi/auto"', `"model":"${pinnedModel}"`)(pinned), session });

	yield* asked.text;

	const sealed = yield* mocks.baa.received;

	const opened = pipe(
		sealed,
		Array.some(({ body }) => Str.includes(`[content of h1]\\n${ruleAnswer}\\n[end of h1]`)(body)),
	);

	assert.isTrue(opened);
});

const unreadable = Effect.gen(function* unreadable() {
	const { client } = yield* checker;

	const response = yield* client.execute(
		HttpClientRequest.post(sessionPaths.answerCheck).pipe(
			HttpClientRequest.bodyText('{"answer":"x"}', "application/json"),
		),
	);

	assert.strictEqual(response.status, unreadableStatus);
});

it.layer(Layer.provideMerge(Layer.mergeAll(SessionRequests.layer, FetchHttpClient.layer), NodeServices.layer))(
	"the answer check",
	(test) => {
		test.effect(
			"clears an answer with internal ids only and lists it as cleared, and asks for rewrite 1 of 5 naming the rule's kind and value or the judge's kind and score, with the way out, counted per subagent",
			() => outcomes,
		);
		test.effect(
			"gives up after the fifth rewrite, seals the answer under a handle the pinned subagent can open, keeps giving up until a clean answer, lists the last withheld answer's reply in status until then, and counts it all",
			() => gaveUp,
		);
		test.effect("refuses a request that is not the contract's", () => unreadable);
	},
);
